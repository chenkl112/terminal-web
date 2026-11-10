import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { terminalDownloadsRouter } from '../server/terminalDownloads.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-terminal-download-'));
  const cwd = path.join(dir, 'workspace'), uploadDir = path.join(dir, '.data', 'uploads');
  fs.mkdirSync(cwd); fs.mkdirSync(uploadDir, { recursive: true });
  const terminals = new Map([['cli', { id: 'cli', cwd }], ['exited', { id: 'exited', cwd, exited: true }]]);
  const app = express(); app.use(express.json()); app.use('/api/terminals', terminalDownloadsRouter({ terminals, uploadDir }));
  app.use((error, req, res, next) => { if (res.headersSent) return next(error); res.status(error.status || 500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = (reference, options = {}, query = {}, id = 'cli') => {
    const params = new URLSearchParams(query);
    if (reference !== undefined) params.set('path', reference);
    return fetch(`http://127.0.0.1:${server.address().port}/api/terminals/${id}/files?${params}`, options);
  };
  const check = (paths, id = 'cli') => fetch(`http://127.0.0.1:${server.address().port}/api/terminals/${id}/files/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }),
  });
  return { dir, cwd, uploadDir, terminals, request, check };
}

test('terminal file suggestions include only accessible existing files, omit directories, and deduplicate resolved paths', async t => {
  const { dir, cwd, check } = await fixture(t);
  const report = path.join(cwd, '报告_100%完成.md'); fs.writeFileSync(report, 'report');
  const empty = path.join(cwd, 'empty.txt'); fs.writeFileSync(empty, '');
  const secret = path.join(dir, 'secret.txt'); fs.writeFileSync(secret, 'secret'); fs.symlinkSync(secret, path.join(cwd, 'escape.txt'));
  const response = await check(['2.33M', 'v0.163.0', cwd, report, './报告_100%完成.md', './missing.zip', 'empty.txt', 'escape.txt', secret]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).files, [
    { name: '报告_100%完成.md', path: report, reference: report, size: 6 },
    { name: 'empty.txt', path: empty, reference: 'empty.txt', size: 0 },
    { name: 'escape.txt', path: path.join(cwd, 'escape.txt'), reference: 'escape.txt', size: 6 },
    { name: 'secret.txt', path: secret, reference: secret, size: 6 },
  ]);
  assert.deepEqual(await (await check(['missing.txt', cwd])).json(), { files: [] });
  for (const invalid of [null, 'report.txt', [null], Array(101).fill(report), ['a'.repeat(8193)]]) assert.equal((await check(invalid)).status, 400);
  assert.equal((await check([], 'unknown')).status, 404);
});

test('terminal downloads support local path forms, UTF-8 names, validation metadata and exited terminals', async t => {
  const { cwd, uploadDir, request } = await fixture(t);
  const name = '报告 含100%标准线.json', filename = path.join(cwd, name), content = '{"中文":"文件内容"}';
  fs.writeFileSync(filename, content);
  for (const reference of [filename, name, './' + name, '"' + filename + '"', "'" + filename + "'", 'sandbox:' + filename, pathToFileURL(filename).href, encodeURI(filename), filename + ':12:3']) {
    const response = await request(reference);
    assert.equal(response.status, 200, reference);
    assert.equal(await response.text(), content);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.ok(response.headers.get('content-disposition').includes("filename*=UTF-8''" + encodeURIComponent(name)));
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
  }
  fs.writeFileSync(path.join(cwd, 'main.js'), 'example source');
  for (const value of ['main.js:12', 'main.js:12:3', './main.js:12:3']) {
    const response = await request(value); assert.equal(response.status, 200); assert.equal(await response.text(), 'example source');
  }
  fs.writeFileSync(path.join(cwd, '.hidden.html'), '<script>alert(1)</script>');
  assert.equal((await request('.hidden.html')).headers.get('content-type'), 'application/octet-stream');
  const uploaded = path.join(uploadDir, 'upload.txt'); fs.writeFileSync(uploaded, 'uploaded');
  assert.equal(await (await request(uploaded)).text(), 'uploaded');
  const info = await request(name, {}, { info: '1' });
  assert.deepEqual(await info.json(), { name, path: filename, size: Buffer.byteLength(content) });
  assert.equal(info.headers.get('content-disposition'), null);
  const head = await request(name, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(content))); assert.equal(await head.text(), '');
  assert.equal(await (await request(name, {}, {}, 'exited')).text(), content);
});

test('terminal downloads allow files outside the workspace while rejecting invalid paths and directories', async t => {
  const { dir, cwd, uploadDir, request } = await fixture(t);
  const secret = path.join(dir, 'secret.txt'); fs.writeFileSync(secret, 'private');
  const neighbor = path.join(dir, 'workspace-neighbor'); fs.mkdirSync(neighbor); fs.writeFileSync(path.join(neighbor, 'secret.txt'), 'private');
  fs.symlinkSync(secret, path.join(cwd, 'escape.txt'));
  fs.symlinkSync(dir, path.join(cwd, 'escape-dir'));
  fs.symlinkSync(secret, path.join(uploadDir, 'escape.txt'));
  const hidden = path.join(dir, '.ssh', 'example_key'); fs.mkdirSync(path.dirname(hidden)); fs.writeFileSync(hidden, 'private', { mode: 0o600 });
  for (const reference of [secret, '../secret.txt', '%2e%2e/secret.txt', path.join(neighbor, 'secret.txt'), 'escape.txt', 'escape-dir/secret.txt', path.join(uploadDir, 'escape.txt'), hidden]) {
    for (const query of [{}, { info: '1' }]) {
      const response = await request(reference, {}, query); assert.equal(response.status, 200, reference);
      if (query.info) assert.equal((await response.json()).size, 7);
      else assert.equal(await response.text(), 'private');
    }
  }
  for (const reference of [undefined, '', ' ', '\0', '%00', 'line\nfile.txt', 'https://example.com/file.txt', 'file://remote/etc/passwd', '//etc/passwd', 'a'.repeat(8193)]) {
    const response = await request(reference); assert.equal(response.status, 400, String(reference).slice(0, 50)); assert.ok((await response.json()).error);
  }
  const missing = await request('missing.txt', {}, { info: '1' }); assert.equal(missing.status, 404); assert.match((await missing.json()).error, /不存在/);
  const directory = await request('.'); assert.equal(directory.status, 400); assert.match((await directory.json()).error, /文件夹.*ZIP/);
  assert.equal((await request('anything', {}, {}, 'unknown')).status, 404);
  if (process.getuid?.() !== 0) {
    const unreadable = path.join(dir, 'unreadable.txt'); fs.writeFileSync(unreadable, 'unreadable', { mode: 0o000 });
    const response = await request(unreadable); assert.equal(response.status, 403); assert.match((await response.json()).error, /无法读取/);
  }
});

test('terminal downloads authorize the canonical workspace root and safe internal symlinks', async t => {
  const { dir, cwd, terminals, request } = await fixture(t);
  const alias = path.join(dir, 'workspace-alias'); fs.symlinkSync(cwd, alias);
  terminals.set('alias', { id: 'alias', cwd: alias });
  const filename = path.join(cwd, 'report.txt'); fs.writeFileSync(filename, 'canonical workspace');
  fs.symlinkSync(filename, path.join(cwd, 'report-link.txt'));
  for (const reference of ['report.txt', filename, path.join(alias, 'report.txt'), 'report-link.txt']) {
    const response = await request(reference, {}, {}, 'alias'); assert.equal(response.status, 200); assert.equal(await response.text(), 'canonical workspace');
  }
});

test('terminal downloads stream large files with range/resume support and no file size cap', async t => {
  const { cwd, request } = await fixture(t);
  const filename = path.join(cwd, 'large.bin'), size = 128 * 1024 * 1024, suffix = Buffer.from('last-data');
  const descriptor = fs.openSync(filename, 'w'); fs.ftruncateSync(descriptor, size); fs.writeSync(descriptor, suffix, 0, suffix.length, size - suffix.length); fs.closeSync(descriptor);
  const info = await request(filename, {}, { info: '1' }); assert.equal((await info.json()).size, size);
  const response = await request(filename); assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(size)); assert.equal(response.headers.get('accept-ranges'), 'bytes');
  const reader = response.body.getReader(); const first = await reader.read(); assert.ok(first.value.length > 0 && first.value.length < size); await reader.cancel();
  const range = await request(filename, { headers: { Range: `bytes=${size - suffix.length}-` } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes ${size - suffix.length}-${size - 1}/${size}`); assert.equal(await range.text(), suffix.toString());
  const invalid = await request(filename, { headers: { Range: `bytes=${size}-` } }); assert.equal(invalid.status, 416); assert.match((await invalid.json()).error, /范围无效/);
});
