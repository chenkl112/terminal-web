import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateUsage, usageStatsRouter } from '../server/usageStats.js';
import express from 'express';

const event = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
test('usage statistics attribute cumulative token deltas to local dates and models, ignore malformed or decreasing counts and measure streaks', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mono-usage-stats-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions', '2026'), { recursive: true });
  await fs.mkdir(path.join(home, 'archived_sessions'), { recursive: true });
  const rows = [
    event('2026-10-20T10:00:00Z', 'turn_context', { model: 'alpha' }),
    event('2026-10-20T10:00:01Z', 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } } }),
    event('2026-10-20T10:00:10Z', 'event_msg', { type: 'task_complete' }),
    event('2026-10-21T10:00:00Z', 'turn_context', { model: 'beta' }),
    event('2026-10-21T10:00:01Z', 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 160 } } }),
    event('2026-10-21T10:00:10Z', 'event_msg', { type: 'task_complete' }),
    event('2026-10-21T10:01:00Z', 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 150 } } }),
    '{malformed json',
  ];
  await fs.writeFile(path.join(home, 'sessions', '2026', 'rollout.jsonl'), rows.join('\n'));
  await fs.writeFile(path.join(home, 'archived_sessions', 'other.jsonl'), event('2026-10-22T10:00:00Z', 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 40 } } }));
  const now = () => new Date('2026-10-22T12:00:00Z').getTime();
  const stats = await aggregateUsage({ codexHome: home, now });
  assert.equal(stats.totalTokens, 200); assert.equal(stats.completedTurns, 2); assert.equal(stats.conversationCount, 2);
  assert.equal(stats.models.find(item => item.model === 'alpha').tokens, 100);
  assert.equal(stats.models.find(item => item.model === 'beta').tokens, 60);
  assert.equal(stats.models.find(item => item.model === '未知模型').tokens, 40);
  const daily = Object.fromEntries(stats.activity.map(item => [item.date, item.tokens]));
  assert.equal(daily['2026-10-20'], 100); assert.equal(daily['2026-10-21'], 60); assert.equal(daily['2026-10-22'], 40);
  assert.equal(stats.currentStreak, 3); assert.equal(stats.longestStreak, 3); assert.ok(stats.longestConversationMs > 0);
  assert.equal(stats.activity.length, 365);
});

test('usage statistics endpoint caches rollout scans and supports refresh', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mono-usage-cache-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'sessions')); await fs.writeFile(path.join(home, 'sessions', 'one.jsonl'), event('2026-10-22T10:00:00Z', 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 9 } } }));
  const app = express(); app.use('/api/usage-stats', usageStatsRouter({ codexHome: home, now: () => new Date('2026-10-22T12:00:00Z').getTime() }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/usage-stats`;
  assert.equal((await (await fetch(base)).json()).totalTokens, 9);
  const content = event('2026-10-22T10:01:00Z', 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 15 } } }); await fs.appendFile(path.join(home, 'sessions', 'one.jsonl'), `\n${content}`);
  assert.equal((await (await fetch(base)).json()).totalTokens, 9); assert.equal((await (await fetch(base + '?refresh=1')).json()).totalTokens, 15);
});
