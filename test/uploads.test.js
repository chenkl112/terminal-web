import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { uploadRouter } from '../server/uploads.js';

test('uploads resume from disk, reject duplicate bytes and incomplete completion, and contain folder paths', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-uploads-'));
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadDir);
  let server;
  const uploads = {};
  async function start() {
    const app = express();
    app.use(express.json());
    app.use('/api/uploads', uploadRouter({ uploadDir, uploads, save: () => {} }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  async function stop() {
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  }
  t.after(async () => { if (server.listening) await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(route, body, method = 'POST') {
    const binary = Buffer.isBuffer(body);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/uploads${route}`, {
      method, headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
      ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  await start();
  const id = randomUUID();
  await request('/start', { id, name: 'resume.txt', size: 6, type: 'text/plain' });
  assert.equal((await request(`/${id}/content?offset=0`, Buffer.from('abc'), 'PUT')).data.offset, 3);
  await stop();
  await start();
  assert.equal((await request(`/${id}/status`, undefined, 'GET')).data.offset, 3);
  assert.equal((await request(`/${id}/complete`, {})).status, 409);
  assert.equal((await request(`/${id}/content?offset=0`, Buffer.from('abc'), 'PUT')).status, 409);
  await request(`/${id}/content?offset=3`, Buffer.from('def'), 'PUT');
  const complete = await request(`/${id}/complete`, {});
  assert.equal(fs.readFileSync(complete.data.path, 'utf8'), 'abcdef');
  assert.equal((await request(`/${id}/complete`, {})).status, 200);

  const folder = randomUUID();
  await request('/start', { id: folder, name: '目录', kind: 'folder', size: 0, type: '', fileCount: 0, directoryCount: 1 });
  for (const relativePath of ['../escape', '/absolute', 'a/../b', 'a\\b']) {
    assert.equal((await request(`/${folder}/entries`, { relativePath, directory: true })).status, 400);
  }
  assert.equal((await request(`/${folder}/entries`, { relativePath: '__proto__', directory: true })).status, 200);
  const finished = await request(`/${folder}/complete`, {});
  assert.equal(finished.status, 201);
  assert.ok(fs.statSync(path.join(finished.data.path, '__proto__')).isDirectory());
});

test('uploaded images and downloads are served from the managed hidden data directory', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-upload-download-'));
  const uploadDir = path.join(directory, '.data', 'uploads'); fs.mkdirSync(uploadDir, { recursive: true });
  const uploads = {};
  for (const [name, image, type, contents] of [['照片.png', true, 'image/png', 'png bytes'], ['结果.txt', false, 'text/plain', '下载内容']]) {
    const id = randomUUID(), target = path.join(uploadDir, id); fs.mkdirSync(target);
    const filename = path.join(target, name); fs.writeFileSync(filename, contents);
    uploads[id] = { id, name, image, type, path: filename, contents };
  }
  const app = express(); app.use('/api/uploads', uploadRouter({ uploadDir, uploads, save() {} }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const file of Object.values(uploads)) {
    const url = `http://127.0.0.1:${server.address().port}/api/uploads/${file.id}`;
    const response = await fetch(url); assert.equal(response.status, 200); assert.equal(await response.text(), file.contents);
    if (file.image) assert.match(response.headers.get('content-type'), /^image\/png/);
    else assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
  }
});

test('streaming uploads write before request completion, lock partial offsets and roll back interrupted chunks', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-stream-upload-'));
  const uploadDir = path.join(directory, 'uploads'); fs.mkdirSync(uploadDir);
  const uploads = {}, app = express(); app.use(express.json());
  app.use('/api/uploads', uploadRouter({ uploadDir, uploads, save() {} }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/uploads`;
  async function call(suffix, body, method = 'POST') {
    return fetch(base + suffix, { method, headers: { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
  }
  async function until(check) {
    const deadline = Date.now() + 4000;
    while (!await check()) { assert.ok(Date.now() < deadline, 'stream operation timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  const id = randomUUID();
  const started = await (await call('/start', { id, name: 'abort.bin', size: 9, type: '' })).json();
  assert.equal(started.chunkSize, 32 * 1024 * 1024);
  assert.equal((await call(`/${id}/content?offset=0`, Buffer.from('abc'), 'PUT')).status, 200);
  const req = http.request(`${base}/${id}/content?offset=3`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 6 } });
  req.on('error', () => {}); req.write('de');
  const partial = path.join(directory, 'uploading', id, 'content.part');
  await until(() => fs.statSync(partial).size === 5);
  assert.equal((await call(`/${id}/status`, undefined, 'GET')).status, 409);
  assert.equal((await call(`/${id}/complete`, {})).status, 409);
  assert.equal((await call(`/${id}`, undefined, 'DELETE')).status, 409);
  req.destroy();
  await until(async () => (await call(`/${id}/status`, undefined, 'GET')).status === 200);
  assert.equal(fs.readFileSync(partial, 'utf8'), 'abc');
  assert.equal((await call(`/${id}/content?offset=3`, Buffer.from('defghi'), 'PUT')).status, 200);
  const completed = await (await call(`/${id}/complete`, {})).json();
  assert.equal(fs.readFileSync(completed.path, 'utf8'), 'abcdefghi');

  const largeId = randomUUID(), content = Buffer.alloc(16 * 1024 * 1024 + 113, 87);
  await call('/start', { id: largeId, name: 'large-chunk.bin', size: content.length, type: '' });
  const saved = await call(`/${largeId}/content?offset=0`, content, 'PUT');
  assert.equal(saved.status, 200); assert.equal((await saved.json()).offset, content.length);
  const large = await (await call(`/${largeId}/complete`, {})).json();
  assert.ok(fs.readFileSync(large.path).equals(content));
});

test('folder child completion survives restart without rewriting conversation state for every file', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-staged-folder-'));
  const uploadDir = path.join(directory, 'uploads'); fs.mkdirSync(uploadDir);
  const uploads = {}; let server, base, saves = 0;
  async function start() {
    const app = express(); app.use(express.json()); app.use('/api/uploads', uploadRouter({ uploadDir, uploads, save() { saves++; } }));
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/api/uploads`;
  }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  t.after(async () => { if (server.listening) await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function call(suffix, body, method = 'POST') {
    const response = await fetch(base + suffix, { method, headers: { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
    assert.equal(response.status < 300, true, await response.clone().text()); return response.json();
  }
  await start(); const parentId = randomUUID(), id = randomUUID();
  assert.equal((await call('/start', { id: parentId, name: '目录', size: 6, type: '', kind: 'folder', fileCount: 1, directoryCount: 0 })).stagedFiles, true);
  const child = { id, name: 'child.txt', size: 6, type: '', parentId };
  await call('/start', child); await call(`/${id}/content?offset=0`, Buffer.from('abcdef'), 'PUT');
  await call(`/${id}/complete`, {}); assert.equal(saves, 0); assert.equal(Object.keys(uploads).length, 0);
  await stop(); await start();
  const resumed = await call('/start', child); assert.equal(resumed.attachment.size, 6);
  await call(`/${parentId}/entries`, { relativePath: 'child.txt', uploadId: id });
  await call(`/${parentId}/entries`, { relativePath: 'child.txt', uploadId: id });
  const completed = await call(`/${parentId}/complete`, {});
  assert.equal(saves, 1); assert.deepEqual(Object.keys(uploads), [parentId]);
  assert.equal(fs.readFileSync(path.join(completed.path, 'child.txt'), 'utf8'), 'abcdef');
  assert.equal(fs.existsSync(path.join(directory, 'uploading', id)), false);
  assert.equal(fs.existsSync(path.join(uploadDir, id)), false);
});
