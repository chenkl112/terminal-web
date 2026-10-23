import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { allPages, historyRouter, nativeDetails } from '../server/history.js';

async function serve(t, state, call) {
  const app = express(); app.use(express.json());
  app.use('/api/history', historyRouter({ state, codex: { call }, save() {}, broadcast() {}, models: () => [{ model: 'default', defaultReasoningEffort: 'medium' }] }));
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/history`;
  return async (suffix = '', data) => {
    const response = await fetch(base + suffix, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
}

test('history reads every native page and archive status, deduplicates web sessions and keeps UI pagination stable', async t => {
  const threads = Array.from({ length: 91 }, (_, i) => ({ id: randomUUID(), name: `历史 ${i}`, cwd: i % 2 ? '/work/a' : '/work/b', createdAt: 100, updatedAt: 1000 - i, archived: i >= 80 }));
  const local = { id: randomUUID(), threadId: threads[0].id, title: '自定义名称', cwd: '/work/b', workspaceId: 'b', createdAt: 1, updatedAt: 1 };
  const state = { conversations: [local], workspaces: [{ id: 'b', path: '/work/b', name: 'b' }] };
  const calls = [];
  const get = await serve(t, state, async (method, params) => {
    calls.push({ method, params }); assert.equal(method, 'thread/list'); assert.deepEqual(params.modelProviders, []);
    const group = threads.filter(item => item.archived === params.archived);
    const offset = Number(params.cursor || 0);
    return { data: group.slice(offset, offset + 25), nextCursor: offset + 25 < group.length ? String(offset + 25) : null };
  });
  const first = await get(); assert.equal(first.total, 91); assert.equal(first.items.length, 40);
  assert.equal(first.items[0].key, local.id); assert.equal(first.items[0].title, '自定义名称');
  state.conversations.push({ id: randomUUID(), threadId: randomUUID(), title: '新加入', updatedAt: Date.now() });
  const second = await get(`?cursor=${encodeURIComponent(first.nextCursor)}`);
  const third = await get(`?cursor=${encodeURIComponent(second.nextCursor)}`);
  const keys = [...first.items, ...second.items, ...third.items].map(item => item.key);
  assert.equal(new Set(keys).size, 91); assert.equal(third.nextCursor, null); assert.equal(calls.length, 5);
  const filtered = await get('?q=%E5%8E%86%E5%8F%B2&cwd=%2Fwork%2Fa&archived=true');
  assert.equal(filtered.total, 5); assert.ok(filtered.items.every(item => item.cwd === '/work/a' && item.archived));
  assert.deepEqual(first.workspaces, ['/work/a', '/work/b']);
});

test('opening native history loads full turn and item pages without resuming or executing a thread', async t => {
  const id = randomUUID(); const calls = [];
  const state = { conversations: [], workspaces: [] };
  const get = await serve(t, state, async (method, params) => {
    calls.push(method);
    if (method === 'thread/goal/get') return { goal: { objective: '历史目标', status: 'paused', threadId: id, tokensUsed: 22 } };
    if (method === 'thread/read') return { thread: { id, name: '旧会话', cwd: '/old/workspace', createdAt: 100, updatedAt: 200 } };
    if (method === 'thread/list') return { data: params.archived ? [{ id }] : [], nextCursor: null };
    if (method === 'thread/turns/list') return params.cursor ? { data: [{ id: 't2', itemsView: 'full', items: [{ id: 'answer', type: 'agentMessage', text: '完整回复' }] }], nextCursor: null }
      : { data: [{ id: 't1', itemsView: 'notLoaded', items: [] }], nextCursor: 'turn2' };
    if (method === 'thread/items/list') return params.cursor ? { data: [{ id: 'a1', type: 'agentMessage', text: '第一轮回复' }], nextCursor: null }
      : { data: [{ id: 'u1', type: 'userMessage', content: [] }], nextCursor: 'item2' };
    throw new Error(`Unexpected mutation: ${method}`);
  });
  let opened = await get('/open', { key: id });
  assert.equal(opened.conversation.turns.length, 2); assert.equal(opened.conversation.turns[0].items.length, 2);
  assert.equal(opened.conversation.goal.objective, '历史目标');
  assert.equal(opened.conversation.turns[1].items[0].text, '完整回复'); assert.ok(opened.conversation.archivedAt);
  assert.equal(opened.workspace.path, '/old/workspace'); assert.equal(state.conversations.length, 1);
  const count = calls.length;
  opened = await get('/open', { key: id }); assert.equal(calls.length, count);
  Object.assign(state.conversations[0], { historyLoadedAt: 0, settingsCustomized: true, model: 'chosen', effort: 'high', permissionMode: 'full-access', pinnedAt: 12, title: '改过的标题' });
  opened = await get('/open', { key: id });
  assert.equal(opened.conversation.model, 'chosen'); assert.equal(opened.conversation.permissionMode, 'full-access');
  assert.equal(opened.conversation.title, '改过的标题'); assert.equal(opened.conversation.pinnedAt, 12); assert.equal(state.conversations.length, 1);
});

test('native rollout metadata keeps latest model, permission and real token counts; missing rollouts are readable', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rollout.jsonl');
  fs.writeFileSync(file, [
    { type: 'turn_context', payload: { model: 'old', effort: 'low', sandbox_policy: { type: 'read-only' } } },
    { type: 'turn_context', payload: { model: 'new', effort: 'high', sandbox_policy: { type: 'danger-full-access' } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5000 }, last_token_usage: { total_tokens: 1000 }, model_context_window: 10000 } } },
  ].map(record => JSON.stringify(record)).join('\n'));
  const details = await nativeDetails(file);
  assert.equal(details.model, 'new'); assert.equal(details.effort, 'high'); assert.equal(details.permissionMode, 'full-access');
  assert.equal(details.usage.total.totalTokens, 5000); assert.equal(details.usage.last.totalTokens, 1000); assert.equal(details.usage.modelContextWindow, 10000);
  assert.deepEqual(await nativeDetails(path.join(directory, 'missing.jsonl')), {});
});

test('broken native paging reports an error instead of looping forever', async () => {
  await assert.rejects(allPages(async () => ({ data: [], nextCursor: 'same' }), 'thread/list', {}), /分页异常/);
});
