import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { terminalManager } from '../server/terminals.js';

test('all clients share one protected default terminal per workspace, including simultaneous requests', async t => {
  const terminals = new Map(), children = [];
  const state = { workspaces: [{ id: 'a', path: '/tmp' }, { id: 'b', path: '/tmp' }] };
  const manager = terminalManager({ state, defaultWorkspaceId: 'a', terminals, broadcast() {}, spawn(command, args) {
    const child = { command, args, killed: false, onData(fn) { this.output = fn; }, onExit(fn) { this.exit = fn; }, kill() { this.killed = true; } };
    children.push(child); return child;
  } });
  const app = express(); app.use(express.json()); app.use('/api/terminals', manager.router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (suffix, body, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}/api/terminals${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const results = await Promise.all(Array.from({ length: 20 }, async () => (await request('/default', { workspaceId: 'a' })).json()));
  assert.equal(new Set(results.map(result => result.id)).size, 1); assert.equal(children.length, 1);
  const first = results[0]; assert.equal(first.isDefault, true); assert.equal(terminals.size, 1);
  assert.deepEqual(children[0].args, []);
  assert.equal((await request(`/${first.id}`, undefined, 'DELETE')).status, 403);
  assert.equal(children[0].killed, false); assert.ok(terminals.has(first.id));
  const other = await (await request('/default', { workspaceId: 'b' })).json();
  assert.notEqual(other.id, first.id); assert.equal(terminals.size, 2);

  children[0].exit({ exitCode: 0 }); assert.equal(terminals.get(first.id).exited, true);
  const reopened = await Promise.all(Array.from({ length: 10 }, async () => (await request('/default', { workspaceId: 'a' })).json()));
  assert.ok(reopened.every(result => result.id === first.id && !result.exited)); assert.equal(children.length, 3);
  children[0].exit({ exitCode: 99 }); children[0].output('stale');
  assert.equal(terminals.get(first.id).exited, false); assert.equal(terminals.get(first.id).replay, '');
  children[2].output('shared output'); assert.equal(terminals.get(first.id).replay, 'shared output');
  const shell = await (await request('', { workspaceId: 'a' })).json(); assert.equal(shell.isDefault, false);
  assert.equal((await request(`/${shell.id}`, undefined, 'DELETE')).status, 200); assert.equal(children[3].killed, true);
  for (let i = 0; i < 10; i++) assert.equal((await request('', { workspaceId: 'a' })).status, 201);
  assert.equal((await request('', { workspaceId: 'a' })).status, 400);
  assert.equal((await (await request('/default', { workspaceId: 'a' })).json()).id, first.id);
  assert.equal((await request('/default', { workspaceId: 'missing' })).status, 404);
});

test('failed Codex startup leaves no phantom default terminal and can be retried', () => {
  let failed = true; const terminals = new Map();
  const manager = terminalManager({ state: { workspaces: [{ id: 'a', path: '/tmp' }] }, defaultWorkspaceId: 'a', terminals, broadcast() {}, spawn() {
    if (failed) throw new Error('spawn failed');
    return { onData() {}, onExit() {} };
  } });
  assert.throws(() => manager.ensureDefault('a'), /spawn failed/); assert.equal(terminals.size, 0);
  failed = false; assert.equal(manager.ensureDefault('a').isDefault, true); assert.equal(terminals.size, 1);
});
