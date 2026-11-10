import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputSpeedTracker } from '../src/outputSpeed.js';

const conversation = (id, total, active = false, turn = 'turn') => ({ id, status: active ? 'active' : 'idle', activeTurnId: active ? turn : null, turns: [], usage: total == null ? null : { total: { outputTokens: total } } });

test('output speed excludes historical tokens and freezes task time before delayed final usage', () => {
  const tracker = new OutputSpeedTracker();
  assert.equal(tracker.observe(conversation('a', 10000), 0, true).outputSpeed, null);
  tracker.observe(conversation('a', 10000, true), 1000);
  const live = tracker.observe(conversation('a', 10200, true), 3000).outputSpeed;
  assert.deepEqual(live, { tokensPerSecond: 100, tokens: 200, elapsedMs: 2000, partial: false });
  tracker.observe(conversation('a', 10200), 5000);
  const final = tracker.observe(conversation('a', 10400), 8000).outputSpeed;
  assert.deepEqual(final, { tokensPerSecond: 100, tokens: 400, elapsedMs: 4000, partial: false });
});

test('reconnects measure only observed increments and do not invent rates for old sessions', () => {
  const tracker = new OutputSpeedTracker();
  assert.equal(tracker.observe(conversation('a', 90000, true), 0, true).outputSpeed, null);
  assert.equal(tracker.observe(conversation('a', 90100, true), 1000).outputSpeed.tokensPerSecond, 100);
  assert.equal(tracker.observe(conversation('a', 91000, true), 10000, true).outputSpeed, null);
  const resumed = tracker.observe(conversation('a', 91200, true), 12000).outputSpeed;
  assert.equal(resumed.tokens, 200); assert.equal(resumed.partial, true); assert.equal(resumed.tokensPerSecond, 100);
  assert.equal(tracker.observe(conversation('a', 92000), 20000, true).outputSpeed, null);
});

test('new tasks include the first reported tokens, independent tasks reset baselines and counters can restart', () => {
  const tracker = new OutputSpeedTracker();
  tracker.startNew(conversation('a', null, true), 0);
  assert.equal(tracker.observe(conversation('a', 300, true), 3000).outputSpeed.tokensPerSecond, 100);
  tracker.observe(conversation('a', 300), 3000);
  tracker.observe(conversation('a', 300, true, 'next'), 4000);
  const next = tracker.observe(conversation('a', 500, true, 'next'), 5000).outputSpeed;
  assert.equal(next.tokens, 200); assert.equal(next.tokensPerSecond, 200);
  assert.equal(tracker.observe(conversation('b', 8000), 5000, true).outputSpeed, null);
  assert.equal(tracker.observe(conversation('a', 0, true, 'next'), 6000).outputSpeed, null);
  assert.equal(tracker.observe(conversation('a', 100, true, 'next'), 7000).outputSpeed.tokensPerSecond, 100);
});

test('a short request that completes between notifications still has a measured speed', () => {
  const tracker = new OutputSpeedTracker();
  tracker.startExisting(conversation('a', 10000), 0);
  const final = tracker.observe(conversation('a', 10100), 1000).outputSpeed;
  assert.equal(final.tokens, 100); assert.equal(final.tokensPerSecond, 100); assert.equal(final.partial, false);
});

test('completed measurements survive refresh only for the matching turn and output count', () => {
  let saved;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  const tracker = new OutputSpeedTracker(storage);
  const c = { ...conversation('a', 10000), turns: [{ id: 'past', status: 'completed' }] };
  tracker.observe(c, 0, true); tracker.startExisting(c, 0);
  c.status = 'active'; c.activeTurnId = 'new'; c.turns.push({ id: 'new', status: 'inProgress' }); tracker.observe(c, 0);
  c.status = 'idle'; c.activeTurnId = null; c.turns[1].status = 'completed'; c.usage.total.outputTokens = 10100;
  tracker.observe(c, 1000);
  assert.equal(new OutputSpeedTracker(storage).observe(c, 5000, true).outputSpeed.tokensPerSecond, 100);
  c.usage.total.outputTokens = 10200;
  assert.equal(new OutputSpeedTracker(storage).observe(c, 5000, true).outputSpeed, null);
  c.usage.total.outputTokens = 10100; c.turns.push({ id: 'another', status: 'completed' });
  assert.equal(new OutputSpeedTracker(storage).observe(c, 5000, true).outputSpeed, null);
});
