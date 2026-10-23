import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { terminalDraftKey, terminalFilePaths, terminalInputChunks } from '../shared/terminalFiles.js';

test('terminal attachment paths preserve literal filenames instead of executing shell syntax', () => {
  const paths = ["/tmp/中文 '$PWD $(printf INJECTED) `printf X` file.txt", '/tmp/empty folder', '/tmp/emoji-😀.png'];
  const text = terminalFilePaths(paths.map(path => ({ server: { path } })));
  const args = execFileSync('/bin/sh', ['-c', `set --${text}; printf '%s\\0' "$@"`], { encoding: 'utf8' }).split('\0').slice(0, -1);
  assert.deepEqual(args, paths); assert.equal(/[\r\n]/.test(text), false);
  assert.equal(terminalFilePaths([{ server: { path: '/tmp/bad\ncommand' } }, {}]), '');
  assert.equal(terminalDraftKey({ id: 'old', workspaceId: 'project', isDefault: true }), terminalDraftKey({ id: 'new', workspaceId: 'project', isDefault: true }));
  assert.notEqual(terminalDraftKey({ id: 'one' }), terminalDraftKey({ id: 'two' }));
});

test('large path lists fit terminal websocket limits without splitting Unicode characters', () => {
  const text = '\x1b[200~' + '中😀path '.repeat(20000) + '\x1b[201~';
  const chunks = [...terminalInputChunks(text)];
  assert.equal(chunks.join(''), text); assert.ok(chunks.length > 1);
  for (const chunk of chunks) { assert.ok(Buffer.byteLength(chunk) < 128 * 1024); assert.ok(chunk.length <= 16384); assert.equal(Buffer.from(chunk).toString('utf8'), chunk); }
});
