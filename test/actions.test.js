import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { actionsRouter } from '../server/actions.js';

test('slash actions call native compact/review/fork, preserve fork history and reject concurrent mutations', async t => {
  const c = { id: 'chat', threadId: 'native', title: 'Original', cwd: '/workspace', turns: [{ id: 't0', items: [] }], attachments: { client: { text: 'hello', files: [] } }, fast: true, mode: 'plan', status: 'idle' };
  const state = { conversations: [c] }, calls = [], loaded = new Set();
  const codex = { async call(method, params) {
    calls.push({ method, params });
    if (method === 'thread/compact/start') return {};
    if (method === 'review/start') return { turn: { id: 'review' } };
    if (method === 'thread/fork') return { thread: { id: 'forked' } };
    if (method === 'thread/turns/list') return { data: [{ id: 'old-turn', items: [{ id: 'a', type: 'agentMessage', text: 'saved answer' }], itemsView: 'full' }], nextCursor: null };
    if (method === 'skills/list') return { data: [{ cwd: c.cwd, skills: [{ name: 'skill', path: '/skill/SKILL.md' }] }] };
    throw Error(method);
  } };
  const app = express(); app.use(express.json()); app.use(actionsRouter({ codex, state, loaded, save() {}, publish() {}, ensureLoaded: async (conversation, refresh) => assert.equal(refresh, true), threadSettings: () => ({ serviceTier: 'priority' }) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = async action => fetch(`http://127.0.0.1:${server.address().port}/chat/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
  assert.equal((await call('compact')).status, 200); assert.equal(calls.at(-1).method, 'thread/compact/start');
  const fork = await (await call('fork')).json();
  assert.equal(fork.conversation.turns[0].items[0].text, 'saved answer'); assert.equal(fork.conversation.fast, true);
  assert.equal(fork.conversation.mode, 'plan'); assert.ok(loaded.has('forked')); assert.notEqual(fork.conversation.id, c.id);
  fork.conversation.attachments.client.text = 'changed'; assert.equal(c.attachments.client.text, 'hello');
  assert.equal((await call('review')).status, 200); assert.equal(c.status, 'active');
  assert.deepEqual(calls.find(call => call.method === 'review/start').params.target, { type: 'uncommittedChanges' });
  assert.equal((await call('compact')).status, 409);
  c.status = 'idle'; c.activeTurnId = null; c.archivedAt = 1;
  assert.equal((await call('review')).status, 409);
  assert.equal((await call('skills')).status, 200);
});

test('diff action reads actual tracked working tree changes without running a shell', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-diff-'));
  execFileSync('git', ['init', '-q', cwd]); fs.writeFileSync(path.join(cwd, 'file.txt'), 'before\n');
  execFileSync('git', ['-C', cwd, 'add', 'file.txt']);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Initial']);
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'after\n');
  const app = express(); app.use(express.json()); app.use(actionsRouter({ codex: {}, state: { conversations: [{ id: 'chat', cwd }] } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'diff' }) });
  assert.equal(response.status, 200); const result = await response.json(); assert.match(result.diff, /-before/); assert.match(result.diff, /\+after/);
});
