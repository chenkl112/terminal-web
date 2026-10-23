import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateWorkspaces, getWorkspace } from '../server/workspaces.js';

test('workspace migration keeps historical messages, settings, pins, archives and workspace IDs across restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const history = [{ id: 'turn', items: [{ type: 'agentMessage', text: '历史消息' }] }];
  const state = { conversations: [{ id: 'old-chat', createdAt: 100, permissionMode: 'full-access', turns: history }], uploads: {} };
  const id = migrateWorkspaces(state, directory);
  assert.equal(state.conversations[0].workspaceId, id);
  assert.equal(state.conversations[0].cwd, directory);
  state.conversations[0].pinnedAt = 200;
  const another = path.join(directory, 'another'); fs.mkdirSync(another);
  state.workspaces.push({ id: 'other', name: 'another', path: another });
  state.conversations.push({ id: 'archived', workspaceId: 'other', createdAt: 300, archivedAt: 400, turns: [] });
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(migrateWorkspaces(restored, directory), id);
  assert.deepEqual(restored.conversations[0].turns, history);
  assert.equal(restored.conversations[0].permissionMode, 'full-access');
  assert.equal(restored.conversations[0].pinnedAt, 200);
  assert.equal(restored.conversations[1].archivedAt, 400);
  assert.equal(restored.conversations[1].cwd, another);
  assert.equal(getWorkspace(restored, 'other', id).path, another);
  assert.throws(() => getWorkspace(restored, 'unknown', id), error => error.status === 404);
});
