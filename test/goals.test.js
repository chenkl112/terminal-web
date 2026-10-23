import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { goalsRouter } from '../server/goals.js';
import { applyNotification } from '../shared/conversation.js';

test('goal lifecycle uses explicit user origin, handles budget and pauses active turns without creating chat turns', async t => {
  const activations = [];
  const c = { id: 'chat', threadId: 'native', turns: [], status: 'idle' }, state = { conversations: [c] }, calls = [];
  let stored = null;
  const codex = { async call(method, params) {
    calls.push({ method, params });
    if (method === 'thread/goal/get') return { goal: stored };
    if (method === 'thread/goal/set') {
      assert.equal(params.origin, 'user');
      stored = { objective: stored?.objective, status: stored?.status, tokensUsed: 0, threadId: c.threadId, ...stored, ...params };
      return { goal: stored };
    }
    if (method === 'thread/goal/clear') { assert.equal(params.origin, 'user'); stored = null; return {}; }
    if (method === 'turn/interrupt') { c.status = 'idle'; c.activeTurnId = null; return {}; }
    throw Error(method);
  } };
  const app = express(); app.use(express.json()); app.use(goalsRouter({ codex, state, ensureLoaded: async (conversation, refresh) => { activations.push(refresh); }, save() {}, publish() {} }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = data => fetch(`http://127.0.0.1:${server.address().port}/chat/goal`, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
  assert.equal((await (await request()).json()).goal, null);
  assert.equal((await request({ operation: 'create', objective: '完成测试目标' })).status, 200);
  assert.equal(stored.status, 'active'); assert.equal(stored.tokenBudget, null);
  assert.equal((await request({ operation: 'create', objective: '不应覆盖原目标' })).status, 409);
  c.status = 'active'; c.activeTurnId = 'auto-turn';
  assert.equal((await request({ operation: 'pause' })).status, 200); assert.equal(stored.status, 'paused');
  assert.equal(calls.at(-1).method, 'turn/interrupt');
  assert.equal((await request({ operation: 'budget', tokenBudget: 50000 })).status, 200); assert.equal(stored.tokenBudget, 50000);
  assert.equal((await request({ operation: 'budget', tokenBudget: -1 })).status, 400);
  assert.equal((await request({ operation: 'resume' })).status, 200); assert.equal(stored.status, 'active');
  assert.ok(!calls.some(call => call.method === 'turn/start'), 'native goal scheduler owns continuation');
  assert.deepEqual(activations, [true, true], 'only creating and resuming refresh native model and Fast settings');
  applyNotification(c, 'thread/goal/updated', { threadId: c.threadId, turnId: 'telemetry', goal: { ...stored, tokensUsed: 12345, status: 'budgetLimited' } });
  assert.equal(c.goal.tokensUsed, 12345); assert.equal(c.goal.status, 'budgetLimited'); assert.equal(c.turns.length, 0);
  assert.equal((await request({ operation: 'clear' })).status, 200); assert.equal(c.goal, null);
  applyNotification(c, 'thread/goal/cleared', { threadId: c.threadId }); assert.equal(c.goal, null);
  c.archivedAt = 1; assert.equal((await request({ operation: 'create', objective: '不应开始' })).status, 409);
});
