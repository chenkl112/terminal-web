import test from 'node:test';
import assert from 'node:assert/strict';
import { startTask } from '../server/tasks.js';

const models = [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [{ id: 'priority' }], defaultReasoningEffort: 'medium' }];
function fixture() {
  const state = { workspaces: [{ id: 'workspace', name: 'Project', path: '/tmp/project' }], conversations: [] }, loaded = new Set(), calls = [], broadcasts = [], saves = [];
  const codex = { status: 'ready', async call(method, params) { calls.push({ method, params }); return { thread: { id: 'thread' }, model: params.model, reasoningEffort: params.config?.model_reasoning_effort }; } };
  return { state, loaded, calls, broadcasts, saves, codex, options: { workspaceId: 'workspace', model: 'gpt-6.1-sol', effort: 'medium', permissionMode: 'full-access', fast: true, mode: 'plan', text: '做一项任务', attachments: [] },
    run(startTurn) { return startTask({ options: this.options, codex: this.codex, state, models, defaultWorkspaceId: 'workspace', loaded, save: (...args) => saves.push(args), broadcast: item => broadcasts.push(item), startTurn }); } };
}

test('new task persists only after turn/start succeeds and carries its selected settings', async () => {
  const f = fixture(); let provisionalSeen = false;
  const result = await f.run(async (conversation, body) => {
    provisionalSeen = conversation.provisional && f.state.conversations.length === 1 && !f.saves.length && !f.broadcasts.length;
    assert.equal(body.text, '做一项任务'); assert.equal(conversation.mode, 'plan');
    conversation.activeTurnId = 'turn'; conversation.status = 'active'; return { turnId: 'turn' };
  });
  assert.equal(provisionalSeen, true); assert.equal(result.conversation.provisional, undefined); assert.equal(result.conversation.title, '新建任务');
  assert.equal(result.conversation.activeTurnId, 'turn'); assert.equal(f.state.conversations.length, 1); assert.deepEqual(f.loaded.has('thread'), true);
  assert.equal(f.saves.length, 1); assert.equal(f.broadcasts.length, 1); assert.equal(f.broadcasts[0].type, 'conversation');
  assert.equal(f.calls[0].method, 'thread/start'); assert.equal(f.calls[0].params.sandbox, 'danger-full-access');
  assert.equal(f.calls[0].params.approvalPolicy, 'never'); assert.equal(f.calls[0].params.serviceTier, 'priority');
});

test('failed turn start leaves no persisted or listed empty conversation', async () => {
  const f = fixture();
  await assert.rejects(f.run(async () => { throw Object.assign(new Error('turn rejected'), { status: 400 }); }), /turn rejected/);
  assert.equal(f.state.conversations.length, 0); assert.equal(f.loaded.size, 0); assert.equal(f.saves.length, 0); assert.equal(f.broadcasts.length, 0);
});

test('offline and invalid settings cannot create conversations', async () => {
  const f = fixture(); f.codex.status = 'offline';
  await assert.rejects(f.run(async () => ({})), /Codex 尚未就绪/); assert.equal(f.calls.length, 0); assert.equal(f.state.conversations.length, 0);
  f.codex.status = 'ready'; f.options.fast = 'true';
  await assert.rejects(f.run(async () => ({})), /Fast 配置无效/); assert.equal(f.calls.length, 0);
});
