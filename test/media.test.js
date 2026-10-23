import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { mediaRouter } from '../server/media.js';
import { nativeImageSource } from '../shared/media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVkAAAAASUVORK5CYII=', 'base64');
test('conversation files serve referenced images and downloads, including encoded and sandbox paths, while rejecting escapes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-media-'));
  const cwd = path.join(dir, 'workspace'); fs.mkdirSync(cwd);
  const image = path.join(cwd, '照片 样例.png'), prompt = path.join(cwd, 'prompt.txt'), outside = path.join(dir, 'secret.txt'), externalImage = path.join(dir, 'render.png');
  fs.writeFileSync(image, png); fs.writeFileSync(prompt, '生成提示词'); fs.writeFileSync(outside, 'private'); fs.writeFileSync(externalImage, png);
  fs.symlinkSync(outside, path.join(cwd, 'escape.txt')); fs.writeFileSync(path.join(cwd, 'fake.png'), 'not an image');
  const state = { conversations: [{ id: 'chat', cwd, turns: [{ items: [
    { type: 'agentMessage', text: `![图片](<${image}>) [提示词](${prompt}) [越界](${outside}) [符号链接](${path.join(cwd, 'escape.txt')}) ![错误图片](${path.join(cwd, 'fake.png')})` },
    { type: 'imageGeneration', savedPath: externalImage, result: '', status: 'completed' },
  ] }] }] };
  const app = express(); app.use(mediaRouter({ state }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = (value, extra = '', options) => fetch(`http://127.0.0.1:${server.address().port}/chat/files?path=${encodeURIComponent(value)}${extra}`, options);
  for (const value of [image, 'sandbox:' + image, pathToFileURL(image).href, './照片%20样例.png']) {
    const response = await get(value, '&image=1'); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^image\/png/);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(png));
  }
  const download = await get(image, '&download=1'); assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.ok(Buffer.from(await download.arrayBuffer()).equals(png));
  const text = await get(prompt); assert.match(text.headers.get('content-disposition'), /^attachment;/); assert.equal(await text.text(), '生成提示词');
  assert.equal((await get(externalImage, '&image=1')).status, 200);
  assert.equal((await get(outside)).status, 403);
  assert.equal((await get(path.join(cwd, 'escape.txt'))).status, 403);
  assert.equal((await get(path.join(cwd, 'fake.png'), '&image=1')).status, 415);
  assert.equal((await get(path.join(cwd, 'not-referenced.png'))).status, 403);
  const range = await get(image, '&image=1', { headers: { Range: 'bytes=0-7' } }); assert.equal(range.status, 206); assert.ok(Buffer.from(await range.arrayBuffer()).equals(png.subarray(0, 8)));
  fs.unlinkSync(image); assert.equal((await get(image, '&image=1')).status, 404);
});

test('native generated images support saved files, remote URLs and PNG/JPEG base64 results', () => {
  const saved = nativeImageSource({ savedPath: '/tmp/generated.png', result: 'ignored' }, 'chat');
  assert.match(saved.src, /^\/api\/conversations\/chat\/files\?/); assert.match(saved.download, /download=1/);
  assert.equal(nativeImageSource({ result: 'https://example.com/generated.png' }, 'chat').src, 'https://example.com/generated.png');
  assert.match(nativeImageSource({ result: '/9j/' + 'A'.repeat(200) }, 'chat').src, /^data:image\/jpeg;base64,/);
  assert.match(nativeImageSource({ result: 'iVBOR' + 'A'.repeat(200) }, 'chat').src, /^data:image\/png;base64,/);
  assert.equal(nativeImageSource({ result: '', status: 'inProgress' }, 'chat'), null);
});
