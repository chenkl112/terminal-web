import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { mediaRouter } from '../server/media.js';
import { imageFileName, nativeImageSource } from '../shared/media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVkAAAAASUVORK5CYII=', 'base64');
test('conversation files serve referenced files in any directory, including encoded, hidden and symlink paths', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-media-'));
  const cwd = path.join(dir, 'workspace'); fs.mkdirSync(cwd);
  const image = path.join(cwd, '照片 样例.png'), prompt = path.join(cwd, 'prompt.txt'), outside = path.join(dir, 'secret.txt'), externalImage = path.join(dir, 'render.png');
  const percent = path.join(cwd, '报告_含100%标准线.zip'); fs.writeFileSync(percent, 'zip content');
  const source = path.join(cwd, 'main.js'); fs.writeFileSync(source, 'source content');
  fs.writeFileSync(image, png); fs.writeFileSync(prompt, '生成提示词'); fs.writeFileSync(outside, 'private'); fs.writeFileSync(externalImage, png);
  fs.symlinkSync(outside, path.join(cwd, 'escape.txt')); fs.writeFileSync(path.join(cwd, 'fake.png'), 'not an image');
  const state = { conversations: [{ id: 'chat', cwd, turns: [{ items: [
    { type: 'agentMessage', text: `![图片](<${image}>) [提示词](${prompt}) [越界](${outside}) [符号链接](${path.join(cwd, 'escape.txt')}) ![错误图片](${path.join(cwd, 'fake.png')}) [报告](${percent}) [源码](${source}:12:3)` },
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
  for (const reference of [percent, encodeURI(percent), encodeURI(percent).replace('%25', '%'), 'sandbox:' + percent]) {
    const response = await get(reference, '&download=1'); assert.equal(response.status, 200);
    assert.equal(await response.text(), 'zip content');
  }
  for (const reference of [source, source + ':12:3', source + ':12']) {
    const response = await get(reference, '&download=1'); assert.equal(response.status, 200);
    assert.equal(await response.text(), 'source content');
    assert.match(response.headers.get('content-disposition'), /filename="?main\.js"?(?:;|$)/);
  }
  assert.equal((await get(externalImage, '&image=1')).status, 200);
  for (const reference of [outside, path.join(cwd, 'escape.txt')]) {
    const response = await get(reference); assert.equal(response.status, 200); assert.equal(await response.text(), 'private');
  }
  const hidden = path.join(dir, '.ssh', 'example_key'); fs.mkdirSync(path.dirname(hidden)); fs.writeFileSync(hidden, 'test key fixture', { mode: 0o600 });
  state.conversations[0].turns[0].items.push({ type: 'agentMessage', text: `[下载](${hidden})` });
  const key = await get(hidden, '&download=1'); assert.equal(key.status, 200); assert.equal(await key.text(), 'test key fixture');
  assert.match(key.headers.get('content-disposition'), /^attachment;/);
  assert.equal((await get(path.join(cwd, 'fake.png'), '&image=1')).status, 415);
  assert.equal((await get(path.join(cwd, 'not-referenced.png'))).status, 403);
  const range = await get(image, '&image=1', { headers: { Range: 'bytes=0-7' } }); assert.equal(range.status, 206); assert.ok(Buffer.from(await range.arrayBuffer()).equals(png.subarray(0, 8)));
  fs.unlinkSync(image); assert.equal((await get(image, '&image=1')).status, 404);
});

test('native generated images support saved files, remote URLs and PNG/JPEG base64 results', () => {
  assert.equal(imageFileName('/tmp/报告_含100%标准线.zip'), '报告_含100%标准线.zip');
  assert.equal(imageFileName('/tmp/%E6%8A%A5%E5%91%8A_100%%E6%A0%87%E5%87%86.zip'), '报告_100%标准.zip');
  assert.equal(imageFileName('/tmp/main.js:12:3'), 'main.js');
  assert.equal(imageFileName('/tmp/中文%20文件.txt'), '中文 文件.txt');
  const saved = nativeImageSource({ savedPath: '/tmp/generated.png', result: 'ignored' }, 'chat');
  assert.match(saved.src, /^\/api\/conversations\/chat\/files\?/); assert.match(saved.download, /download=1/);
  assert.equal(nativeImageSource({ result: 'https://example.com/generated.png' }, 'chat').src, 'https://example.com/generated.png');
  assert.match(nativeImageSource({ result: '/9j/' + 'A'.repeat(200) }, 'chat').src, /^data:image\/jpeg;base64,/);
  assert.match(nativeImageSource({ result: 'iVBOR' + 'A'.repeat(200) }, 'chat').src, /^data:image\/png;base64,/);
  assert.equal(nativeImageSource({ result: '', status: 'inProgress' }, 'chat'), null);
});
