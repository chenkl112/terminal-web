import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNotification, usageMetrics } from '../shared/conversation.js';

test('completed turn summaries preserve streamed items and canonical completed text', () => {
  const c = { turns: [], status: 'idle' };
  applyNotification(c, 'turn/started', { turn: { id: 't1', status: 'inProgress', items: [] } });
  applyNotification(c, 'item/started', { turnId: 't1', item: { id: 'a1', type: 'agentMessage', text: '' } });
  applyNotification(c, 'item/agentMessage/delta', { turnId: 't1', itemId: 'a1', delta: '流式' });
  applyNotification(c, 'item/agentMessage/delta', { turnId: 't1', itemId: 'a1', delta: '回复' });
  assert.equal(c.turns[0].items[0].text, '流式回复');
  applyNotification(c, 'item/completed', { turnId: 't1', item: { id: 'a1', type: 'agentMessage', text: '最终回复' } });
  applyNotification(c, 'turn/completed', { turn: { id: 't1', status: 'completed', items: [] } });
  assert.equal(c.turns[0].items.length, 1);
  assert.equal(c.turns[0].items[0].text, '最终回复');
  assert.equal(c.activeTurnId, null);
  assert.equal(c.status, 'idle');
});

test('paginated final-item notifications preserve the user message and tool history', () => {
  const c = { turns: [{ id: 't', status: 'inProgress', items: [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '读取附件' }] },
    { id: 'cmd', type: 'commandExecution', aggregatedOutput: '附件内容' },
    { id: 'a', type: 'agentMessage', text: '流式结果' },
  ] }] };
  applyNotification(c, 'turn/completed', { turn: { id: 't', status: 'completed', itemsView: 'notLoaded',
    items: [{ id: 'a', type: 'agentMessage', text: '最终结果' }] } });
  assert.deepEqual(c.turns[0].items.map(i => i.id), ['u', 'cmd', 'a']);
  assert.equal(c.turns[0].items[2].text, '最终结果');
});

test('context uses latest request, not cumulative tokens; unknown capacity remains unknown', () => {
  const usage = { total: { totalTokens: 900000, inputTokens: 850000, outputTokens: 50000 },
    last: { totalTokens: 32000 }, modelContextWindow: 128000 };
  const c = { turns: [] };
  applyNotification(c, 'thread/tokenUsage/updated', { tokenUsage: usage });
  const metrics = usageMetrics(c.usage);
  assert.equal(metrics.total, 900000);
  assert.equal(metrics.percent, 25);
  assert.equal(metrics.used, 32000);
  assert.equal(usageMetrics({ ...usage, modelContextWindow: null }).percent, null);
  assert.equal(usageMetrics(null).total, null);
  assert.equal(usageMetrics(null).percent, null);
});

test('usage details separate cached and uncached input without counting reasoning output twice', () => {
  const metrics = usageMetrics({ total: { totalTokens: 1399461, inputTokens: 1378172, cachedInputTokens: 1344896, outputTokens: 21289, reasoningOutputTokens: 10000 },
    last: { totalTokens: 54800, inputTokens: 53500, cachedInputTokens: 30000, outputTokens: 1300 }, modelContextWindow: 1000000 });
  assert.equal(metrics.uncached, 33276); assert.equal(Math.round(metrics.cacheHit), 98);
  assert.deepEqual(metrics.context, { cached: 30000, uncached: 23500, output: 1300 });
  assert.equal(Object.values(metrics.context).reduce((sum, count) => sum + count, 0), metrics.used);
  assert.equal(usageMetrics(null).cacheHit, null); assert.equal(usageMetrics(null).uncached, null);
  assert.equal(usageMetrics({ total: { inputTokens: 0, cachedInputTokens: 0 } }).cacheHit, 0);
});
