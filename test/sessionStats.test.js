import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStatsTracker, sessionDuration } from '../src/sessionStats.js';

test('session stats separate non-tool time, cumulative parallel tools and first output latency', () => {
  const tracker = new SessionStatsTracker();
  const c = { id: 'c', status: 'idle', turns: [] };
  tracker.observe(c, 0, true);
  c.status = 'active'; c.activeTurnId = 't'; c.turns.push({ id: 't', status: 'inProgress', items: [] });
  tracker.observe(c, 0);
  c.turns[0].items.push({ id: 'answer', type: 'agentMessage', text: 'First token' }, { id: 'a', type: 'commandExecution', status: 'inProgress' });
  tracker.observe(c, 1000);
  c.turns[0].items.push({ id: 'b', type: 'mcpToolCall', status: 'inProgress' }); tracker.observe(c, 2000);
  Object.assign(c.turns[0].items[1], { status: 'completed', durationMs: 2000 }); tracker.observe(c, 3000);
  Object.assign(c.turns[0].items[2], { status: 'completed', durationMs: 2000 }); tracker.observe(c, 4000);
  c.status = 'idle'; c.activeTurnId = null; c.turns[0].status = 'completed';
  const stats = tracker.observe(c, 5000).sessionStats;
  assert.equal(stats.modelMs, 2000); assert.equal(stats.toolMs, 4000);
  assert.equal(stats.ttftMs, 1000); assert.equal(stats.rounds, 1); assert.equal(stats.steps, 2);
});

test('history and partial connections do not invent model time or TTFT', () => {
  const tracker = new SessionStatsTracker();
  const c = { id: 'c', status: 'idle', turns: [{ id: 'past', status: 'completed', durationMs: 9000, items: [
    { id: 'old', type: 'agentMessage', text: 'old response' }, { id: 'tool', type: 'commandExecution', status: 'completed', durationMs: 2000 },
  ] }] };
  const history = tracker.observe(c, 0, true).sessionStats;
  assert.equal(history.modelMs, null); assert.equal(history.ttftMs, null); assert.equal(history.toolMs, 2000);
  c.status = 'active'; c.activeTurnId = 'new'; c.turns.push({ id: 'new', status: 'inProgress', items: [{ id: 'first', type: 'agentMessage', text: 'already streaming' }] });
  tracker.observe(c, 1000, true);
  const partial = tracker.observe(c, 2000).sessionStats;
  assert.equal(partial.ttftMs, null); assert.equal(partial.partial, true); assert.equal(partial.modelMs, 1000);
  const reconnected = tracker.observe(c, 10000, true).sessionStats;
  assert.equal(reconnected.modelMs, 0); assert.equal(reconnected.ttftMs, null);
});

test('TTFT averages complete observed rounds, including a request before a turn ID exists', () => {
  const tracker = new SessionStatsTracker(), c = { id: 'c', status: 'idle', turns: [] };
  tracker.observe(c, 0, true); tracker.request(c, 0);
  c.status = 'active'; tracker.observe(c, 200);
  c.activeTurnId = 't1'; c.turns.push({ id: 't1', status: 'inProgress', items: [] }); tracker.observe(c, 500);
  c.turns[0].items.push({ id: 'r', type: 'reasoning', summary: ['First thought'] }); tracker.observe(c, 1000);
  c.status = 'idle'; c.activeTurnId = null; c.turns[0].status = 'completed'; tracker.observe(c, 2000);
  tracker.request(c, 3000); c.status = 'active'; c.activeTurnId = 't2'; c.turns.push({ id: 't2', status: 'inProgress', items: [] }); tracker.observe(c, 3000);
  c.turns[1].items.push({ id: 'a', type: 'agentMessage', text: 'first response' });
  assert.equal(tracker.observe(c, 6000).sessionStats.ttftMs, 2000);
  assert.equal(sessionDuration(880000), '14分40秒'); assert.equal(sessionDuration(null), '—');
});
