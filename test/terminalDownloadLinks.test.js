import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTerminalDownloadPaths, createTerminalFileLinkProvider, normalizeTerminalDownloadPath, terminalAssetUrl, inspectTerminalAsset } from '../src/terminalDownloads.js';

const cell = (chars = '', width = 1) => ({ getChars: () => chars, getWidth: () => width });
function bufferFrom(texts, cols = 80) {
  const lines = [];
  for (const text of texts) {
    let cells = [], wrapped = false;
    const flush = () => {
      const row = [...cells, ...Array.from({ length: cols - cells.length }, () => cell())];
      lines.push({ length: cols, isWrapped: wrapped, getCell: x => row[x] });
      cells = []; wrapped = true;
    };
    for (const chars of Array.from(text)) {
      const width = /[\p{Script=Han}\p{Extended_Pictographic}]/u.test(chars) ? 2 : 1;
      if (cells.length + width > cols) flush();
      cells.push(cell(chars, width));
      if (width === 2) cells.push(cell('', 0));
    }
    flush();
  }
  return { length: lines.length, getLine: y => lines[y] };
}
function terminal(texts, cols = 80) {
  const normal = bufferFrom(texts, cols);
  return { cols, buffer: { active: normal, normal } };
}
function linksAt(term, row, onOpen = () => {}) {
  let links;
  createTerminalFileLinkProvider(term, onOpen).provideLinks(row, value => { links = value; });
  return links || [];
}

test('terminal paths retain Unicode and literal percent while removing source locations', () => {
  for (const [input, expected] of [
    ['/tmp/含100%标准线.zip:12:3', '/tmp/含100%标准线.zip'],
    ['"/tmp/中文 报告.json"', '/tmp/中文 报告.json'],
    ['`./src/main.jsx:29`', './src/main.jsx'],
    ['[查看报告](</tmp/输出 100%.pdf>)', '/tmp/输出 100%.pdf'],
    ['../assets/照片.png#L12', '../assets/照片.png'],
    ['~/Downloads/report.zip', '~/Downloads/report.zip'],
    ['file:///tmp/hello%20world.txt', 'file:///tmp/hello%20world.txt'],
    ['sandbox:/mnt/data/report.pdf', '/mnt/data/report.pdf'],
    ['dist/report.zip', 'dist/report.zip'],
  ]) assert.equal(normalizeTerminalDownloadPath(input), expected);
  for (const input of ['2.33M', '2.33MB', '150.3MB/s', 'v0.163.0', '0.163.0', '1.2s', 'https://host/report.pdf', 'ftp://host/file.zip', 'file://remote/tmp/file.zip', 'file:///', 'file://localhost/', '--output=report.zip', '/goal', '/', './', '../', '~/', '/tmp/.', '/tmp/..', '//host/share.txt', 'hello', 'report.txt\nrm -rf /']) {
    assert.equal(normalizeTerminalDownloadPath(input), '', input);
  }
});

test('numeric-looking files remain addressable through explicit paths while telemetry is omitted', () => {
  assert.equal(normalizeTerminalDownloadPath('./2.33M'), './2.33M');
  const term = terminal(['2.33M v0.163.0 150.3MB/s 1.2s ./report.zip']);
  assert.deepEqual(collectTerminalDownloadPaths(term), ['./report.zip']);
});

test('web asset links stay on this origin and reject traversal, encoded escapes and filesystem protocols', () => {
  const origin = 'http://local.test:3210';
  assert.equal(terminalAssetUrl('/assets/演示100%.zip', origin), '/assets/%E6%BC%94%E7%A4%BA100%25.zip');
  assert.equal(terminalAssetUrl('assets/report.zip?download=1#file', origin), '/assets/report.zip?download=1');
  assert.equal(terminalAssetUrl(origin + '/assets/report.zip', origin), '/assets/report.zip');
  assert.equal(normalizeTerminalDownloadPath('/assets/report.zip?download=1'), '/assets/report.zip?download=1');
  for (const invalid of ['https://other.test/assets/report.zip', '//other.test/assets/report.zip', '/assets/../secret', '/assets/%2e%2e/secret', '/assets/%252e%252e/secret', '/assets/%2e%2e%2fsecret', '/assets/%5csecret', '/assets/%00secret', '/assets/', '/etc/passwd', 'file:///assets/report.zip', origin + '?redirect=/assets/report.zip']) {
    assert.equal(terminalAssetUrl(invalid, origin), '', invalid);
  }
});

test('asset metadata uses HEAD and rejects SPA fallback pages instead of downloading index.html as a ZIP', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/assets/report.zip') return new Response(null, { headers: { 'Content-Type': 'application/zip', 'Content-Length': '18624' } });
    if (url === '/assets/report.html') return new Response(null, { headers: { 'Content-Type': 'text/html', ETag: 'report' } });
    return new Response(null, { headers: { 'Content-Type': 'text/html', ETag: 'index' } });
  };
  assert.deepEqual(await inspectTerminalAsset('/assets/report.zip', { fetch: fakeFetch }), { name: 'report.zip', path: '/assets/report.zip', size: 18624, reference: '/assets/report.zip', asset: true });
  await assert.rejects(inspectTerminalAsset('/assets/missing.zip', { fetch: fakeFetch }), /不存在/);
  await assert.rejects(inspectTerminalAsset('/assets/missing.html', { fetch: fakeFetch }), /不存在/);
  assert.equal((await inspectTerminalAsset('/assets/report.html', { fetch: fakeFetch })).name, 'report.html');
  assert.ok(calls.every(call => call.options.method === 'HEAD' && call.options.redirect === 'error'));
});

test('quoted and Markdown filenames become links, activation only opens the chooser', () => {
  const opened = [];
  const term = terminal(['报告："/tmp/中文 100%.zip" 和 [下载](./output/a b.pdf)', 'https://host/report.pdf --out=files.json /help /tmp/']);
  const links = linksAt(term, 1, value => opened.push(value));
  assert.equal(links.length, 2);
  assert.deepEqual(opened, []);
  for (const link of links) link.activate({});
  assert.deepEqual(opened, ['/tmp/中文 100%.zip', './output/a b.pdf']);
  assert.equal(linksAt(term, 2).length, 0);
});

test('link positions follow wide CJK/emoji cells and wrapped logical lines', () => {
  const term = terminal(['中 /tmp/图😀.png'], 10);
  const opened = [];
  const first = linksAt(term, 1, path => opened.push(path));
  const second = linksAt(term, 2);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first[0].range, { start: { x: 4, y: 1 }, end: { x: 6, y: 2 } });
  first[0].activate({});
  assert.deepEqual(opened, ['/tmp/图😀.png']);
  assert.equal(first[0].text, '/tmp/图😀.png');
});

test('wide glyph wrap padding is not inserted into file names', () => {
  const term = terminal(['/tmp/图.zip'], 6);
  assert.deepEqual(collectTerminalDownloadPaths(term), ['/tmp/图.zip']);
  assert.deepEqual(linksAt(term, 1)[0].range, { start: { x: 1, y: 1 }, end: { x: 6, y: 2 } });
});

test('recent files are distinct, newest first, and include the normal scrollback', () => {
  const term = terminal(['/tmp/old.txt', '/tmp/shared.txt', '/tmp/one.txt /tmp/two.txt']);
  term.buffer.active = bufferFrom(['./report.zip', '/tmp/shared.txt']);
  assert.deepEqual(collectTerminalDownloadPaths(term), ['/tmp/shared.txt', './report.zip', '/tmp/two.txt', '/tmp/one.txt', '/tmp/old.txt']);
  assert.deepEqual(collectTerminalDownloadPaths(term, { limit: 2 }), ['/tmp/shared.txt', './report.zip']);
  assert.deepEqual(collectTerminalDownloadPaths(term, { maxLines: 1 }), ['/tmp/shared.txt']);
  assert.deepEqual(collectTerminalDownloadPaths(term, { limit: 0 }), []);
});

test('recent file scans have a strict line budget and never merge unrelated rows', () => {
  const term = terminal(Array.from({ length: 1000 }, (_, i) => `/tmp/file-${i}.txt`));
  const original = term.buffer.normal.getLine;
  let reads = 0;
  term.buffer.normal.getLine = row => { reads++; return original(row); };
  assert.deepEqual(collectTerminalDownloadPaths(term, { maxLines: 2 }), ['/tmp/file-999.txt', '/tmp/file-998.txt']);
  assert.ok(reads < 12);
  assert.equal(linksAt(term, 0).length, 0);
  assert.equal(linksAt(term, 1001).length, 0);
});
