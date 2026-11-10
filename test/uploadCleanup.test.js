import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { createUploadCleanup, uploadCleanupSettings } from '../server/uploadCleanup.js';
import { uploadRouter } from '../server/uploads.js';

const DAY = 86400000;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-cleanup-'));
  const uploadDir = path.join(root, 'uploads'), codexHome = path.join(root, 'codex');
  fs.mkdirSync(uploadDir); fs.mkdirSync(codexHome);
  const state = { conversations: [], uploads: {} };
  let clock = 20 * DAY, saves = 0;
  const cleanup = createUploadCleanup({ state, uploadDir, codexHome, now: () => clock,
    save: () => { saves++; options.save?.(); }, logger: { info() {}, error() {} } });
  t.after(() => { cleanup.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  function upload(age = 8 * DAY, folder = false) {
    const id = randomUUID(), directory = path.join(uploadDir, id), filename = path.join(directory, folder ? 'folder' : 'file.txt');
    fs.mkdirSync(directory);
    if (folder) { fs.mkdirSync(filename); fs.writeFileSync(path.join(filename, 'child.txt'), 'data'); }
    else fs.writeFileSync(filename, 'data');
    const file = { id, path: filename, name: path.basename(filename), uploadedAt: clock - age, size: 4 };
    state.uploads[id] = file;
    return file;
  }
  function history(name, text, archived = false) {
    const directory = path.join(codexHome, archived ? 'archived_sessions' : 'sessions', '2026');
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, name + '.jsonl'); fs.writeFileSync(filename, text); return filename;
  }
  return { root, uploadDir, codexHome, state, cleanup, upload, history, advance: ms => { clock += ms; }, saves: () => saves };
}

test('only old unused completed uploads are deleted; staging, recent and used files survive', async t => {
  const f = fixture(t), old = f.upload(), oldFolder = f.upload(9 * DAY, true), recent = f.upload(DAY);
  const chat = f.upload(), archive = f.upload(), terminal = f.upload(), message = f.upload();
  f.state.conversations.push({ attachments: { one: { files: [chat] } } },
    { archivedAt: 1, attachments: { two: { files: [archive] } } },
    { turns: [{ items: [{ text: `读取 ${message.path}` }] }] });
  f.cleanup.markTextUsed(`cat '${terminal.path}'`);
  const staging = path.join(f.root, 'uploading', randomUUID()); fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'content.part'), 'incomplete');
  const unregistered = path.join(f.uploadDir, randomUUID()); fs.mkdirSync(unregistered);
  assert.deepEqual(await f.cleanup.run(), { removed: 2, bytes: 8 });
  for (const file of [old, oldFolder]) { assert.equal(fs.existsSync(file.path), false); assert.equal(f.state.uploads[file.id], undefined); }
  for (const file of [recent, chat, archive, terminal, message]) assert.equal(fs.existsSync(file.path), true);
  assert.equal(fs.existsSync(staging), true); assert.equal(fs.existsSync(unregistered), true);
  assert.ok(f.saves() > 0);
  assert.equal((await f.cleanup.run()).removed, 0);
  // Use markers survive removal of a web conversation and process recreation.
  f.state.conversations = [];
  const restarted = createUploadCleanup({ state: f.state, uploadDir: f.uploadDir, codexHome: f.codexHome, now: () => 20 * DAY, save() {} });
  t.after(() => restarted.stop());
  assert.equal((await restarted.run()).removed, 0);
  for (const file of [chat, archive, terminal, message]) assert.equal(fs.existsSync(file.path), true);
});

test('native CLI and archived history protect paths across stream boundaries and appended records', async t => {
  const f = fixture(t), cli = f.upload(), archived = f.upload(), appended = f.upload(DAY);
  const log = f.history('active', 'x'.repeat(256 * 1024 - 12) + cli.path);
  f.history('archived', JSON.stringify({ text: archived.path }), true);
  assert.equal((await f.cleanup.run()).removed, 0);
  assert.ok(cli.usedAt); assert.ok(archived.usedAt);
  // The next sweep reuses unchanged history and scans just the appended tail.
  fs.appendFileSync(log, '\n' + JSON.stringify({ text: appended.path })); f.advance(8 * DAY);
  assert.equal((await f.cleanup.run()).removed, 0);
  assert.ok(appended.usedAt); assert.equal(fs.existsSync(appended.path), true);
});

test('draft keepalive extends retention without marking an attachment permanently used', async t => {
  const f = fixture(t), file = f.upload();
  f.cleanup.touch([file.id, randomUUID()]);
  assert.equal(file.usedAt, undefined);
  assert.equal((await f.cleanup.run()).removed, 0);
  f.advance(6 * DAY); assert.equal((await f.cleanup.run()).removed, 0);
  f.advance(DAY); assert.equal((await f.cleanup.run()).removed, 1);
});

test('unreadable history aborts deletion and a later successful scan retains earlier references', async t => {
  const f = fixture(t), old = f.upload(), used = f.upload();
  f.history('a-good', JSON.stringify({ text: used.path }));
  const broken = path.join(f.codexHome, 'archived_sessions');
  fs.writeFileSync(broken, 'not a directory');
  await assert.rejects(f.cleanup.run());
  assert.equal(fs.existsSync(old.path), true); assert.equal(fs.existsSync(used.path), true);
  fs.unlinkSync(broken);
  assert.equal((await f.cleanup.run()).removed, 1);
  assert.equal(fs.existsSync(used.path), true); assert.ok(used.usedAt);
});

test('path escapes, malformed metadata and symlink directories cannot delete unrelated data', async t => {
  const f = fixture(t), outside = path.join(f.root, 'project'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'important.txt'), 'keep');
  const escaped = f.upload(); escaped.path = path.join(outside, 'important.txt');
  const linked = f.upload(); fs.rmSync(path.dirname(linked.path), { recursive: true }); fs.symlinkSync(outside, path.dirname(linked.path));
  const invalid = f.upload(); invalid.uploadedAt = undefined;
  f.state.uploads['../project'] = { ...escaped, id: '../project' };
  assert.equal((await f.cleanup.run()).removed, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'keep');
  const folder = f.upload(9 * DAY, true); fs.symlinkSync(outside, path.join(folder.path, 'external'));
  assert.equal((await f.cleanup.run()).removed, 1);
  assert.equal(fs.existsSync(outside), true);
});

test('save failure rolls back a moved upload; interrupted cleanup recovers safely', async t => {
  let fail = true;
  const f = fixture(t, { save: () => { if (fail) throw new Error('disk full'); } });
  const file = f.upload();
  await assert.rejects(f.cleanup.run(), /disk full/);
  assert.equal(f.state.uploads[file.id], file); assert.equal(fs.existsSync(file.path), true);
  fail = false;
  // Simulate a crash after rename but before committing the state record removal.
  f.cleanup.touch([file.id]);
  const trash = path.join(f.root, 'upload-trash'); fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(path.dirname(file.path), path.join(trash, file.id));
  assert.equal((await f.cleanup.run()).removed, 0); assert.equal(fs.existsSync(file.path), true);
  // Simulate a crash after the record removal was committed.
  delete f.state.uploads[file.id]; fs.renameSync(path.dirname(file.path), path.join(trash, file.id));
  await f.cleanup.run(); assert.equal(fs.existsSync(path.join(trash, file.id)), false);
});

test('concurrent sweeps coalesce; references added during history I/O protect attachments', async t => {
  const f = fixture(t), file = f.upload();
  f.history('session', 'no reference');
  const first = f.cleanup.run();
  assert.equal(f.cleanup.run(), first);
  f.state.conversations.push({ archivedAt: 123, text: file.path });
  assert.equal((await first).removed, 0);
  f.cleanup.stop(); assert.equal((await f.cleanup.run()).removed, 0);
});

test('keepalive API validates IDs and reports expired drafts', async t => {
  const f = fixture(t), file = f.upload(), missing = randomUUID();
  const app = express(); app.use(express.json());
  app.use('/api/uploads', uploadRouter({ uploadDir: f.uploadDir, uploads: f.state.uploads, save() {}, touch: f.cleanup.touch }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = ids => fetch(`http://127.0.0.1:${server.address().port}/api/uploads/keepalive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  });
  assert.equal((await request(['../file'])).status, 400);
  assert.equal((await request([null])).status, 400);
  assert.equal((await request(Array(1001).fill(file.id))).status, 400);
  const response = await request([file.id, missing]);
  assert.deepEqual(await response.json(), { ok: true, missing: [missing] });
  assert.ok(file.lastAccessedAt); assert.equal(file.usedAt, undefined);
});

test('cleanup settings have conservative defaults, support disabling and reject invalid values', async t => {
  assert.deepEqual(uploadCleanupSettings({}), { retentionMs: 7 * DAY, intervalMs: 3600000 });
  assert.equal(uploadCleanupSettings({ UPLOAD_UNUSED_DAYS: '0' }).retentionMs, 0);
  assert.equal(uploadCleanupSettings({ UPLOAD_UNUSED_DAYS: '1.5', UPLOAD_CLEANUP_INTERVAL_MINUTES: '10' }).retentionMs, 1.5 * DAY);
  for (const value of ['-1', 'NaN', 'Infinity']) assert.throws(() => uploadCleanupSettings({ UPLOAD_UNUSED_DAYS: value }));
  assert.throws(() => uploadCleanupSettings({ UPLOAD_CLEANUP_INTERVAL_MINUTES: '0' }));
  const f = fixture(t), file = f.upload();
  const disabled = createUploadCleanup({ state: f.state, uploadDir: f.uploadDir, save() {}, retentionMs: 0 });
  t.after(() => disabled.stop()); disabled.start();
  assert.deepEqual(await disabled.run(), { removed: 0, bytes: 0 });
  assert.equal(fs.existsSync(file.path), true);
});
