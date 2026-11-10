import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessageSender } from '../server/messages.js';

function fixture({ active = false, call } = {}) {
  const conversation = { id: 'chat', threadId: 'thread', cwd: '/tmp', title: 'Example', status: active ? 'active' : 'idle',
    activeTurnId: active ? 'running' : null, turns: active ? [{ id: 'running', status: 'inProgress', items: [{ id: 'command', type: 'commandExecution', status: 'inProgress' }] }] : [],
    attachments: {}, permissionMode: 'workspace-write', model: 'gpt-6.1-sol', effort: 'medium' };
  const state = { uploads: {} }, calls = [], loaded = [], published = [], used = [];
  const codex = { status: 'ready', async call(method, params) {
    calls.push({ method, params });
    if (call) return call(method, params, conversation);
    return { turn: { id: active ? 'running' : 'new', status: 'inProgress' } };
  } };
  const send = createMessageSender({ codex, state, ensureLoaded: async c => loaded.push(c.threadId), publish: c => published.push(c.id), uploadCleanup: { touch() {}, markUsed: ids => used.push(...ids) } });
  return { conversation, state, calls, loaded, published, used, codex, send: body => send(conversation, body) };
}

test('idle messages start normally while running messages append through native turn/start without interrupt or resume', async () => {
  for (const active of [false, true]) {
    const f = fixture({ active });
    const items = f.conversation.turns[0]?.items;
    const result = await f.send({ text: active ? '再问一下：为什么这样改？' : '开始处理' });
    assert.equal(result.turnId, active ? 'running' : 'new');
    assert.deepEqual(f.calls.map(call => call.method), ['turn/start']);
    assert.deepEqual(f.loaded, active ? [] : ['thread']);
    assert.equal(f.calls[0].params.threadId, 'thread');
    assert.equal(f.calls[0].params.input[0].text, active ? '再问一下：为什么这样改？' : '开始处理');
    assert.ok(f.calls[0].params.clientUserMessageId);
    assert.equal(Object.values(f.conversation.attachments)[0].text, f.calls[0].params.input[0].text);
    assert.equal(f.conversation.status, 'active'); assert.equal(f.conversation.starting, false);
    if (active) assert.equal(f.conversation.turns[0].items, items);
    assert.deepEqual(f.published, ['chat']);
  }
});

test('active follow-ups support attachments, images and selected skills without starting a separate turn', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-followup-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, '补充图片.png'); fs.writeFileSync(filename, 'image fixture');
  const skill = { name: 'fixture', path: path.join(directory, 'SKILL.md') };
  const f = fixture({ active: true, call: async method => method === 'skills/list'
    ? { data: [{ skills: [{ ...skill, enabled: true }] }] } : { turn: { id: 'running', status: 'inProgress' } } });
  f.state.uploads.image = { id: 'image', name: '补充图片.png', path: filename, image: true, size: 13 };
  await f.send({ text: '按这张图片调整 $fixture', attachments: ['image'], skills: [skill] });
  const request = f.calls.find(call => call.method === 'turn/start');
  assert.match(request.params.input[0].text, /补充图片/); assert.ok(request.params.input[0].text.includes(filename));
  assert.deepEqual(request.params.input.slice(1), [{ type: 'skill', ...skill }, { type: 'localImage', path: filename }]);
  assert.deepEqual(f.used, ['image']); assert.deepEqual(f.loaded, []); assert.equal(f.conversation.activeTurnId, 'running');
});

test('completion racing a follow-up uses native atomic routing and does not resurrect a completed turn', async () => {
  const f = fixture({ active: true, call: async (method, params, c) => {
    c.turns[0].status = 'completed'; c.status = 'idle'; c.activeTurnId = null;
    return { turn: { id: 'running', status: 'completed' } };
  } });
  await f.send({ text: '补充问题' });
  assert.equal(f.calls.length, 1); assert.equal(f.conversation.status, 'idle'); assert.equal(f.conversation.activeTurnId, null);
  const g = fixture({ active: true, call: async (method, params, c) => {
    c.turns[0].status = 'completed';
    return { turn: { id: 'next', status: 'inProgress' } };
  } });
  assert.equal((await g.send({ text: '刚结束时的新问题' })).turnId, 'next'); assert.equal(g.conversation.activeTurnId, 'next');
});

test('concurrent submissions are locked, failures release the lock, and invalid state does not submit native calls', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ active: true, call: async () => { await gate; throw new Error('Native rejection'); } });
  const first = f.send({ text: '正在发送' });
  await assert.rejects(f.send({ text: '重复发送' }), /正在提交消息/); assert.equal(f.calls.length, 1);
  release(); await assert.rejects(first, /Native rejection/); assert.equal(f.conversation.starting, false);
  await assert.rejects(f.send({ text: '可以再次尝试' }), /Native rejection/); assert.equal(f.calls.length, 2);
  for (const patch of [{ archivedAt: 1 }, { actionBusy: true }, { goalBusy: true }]) {
    const g = fixture({ active: true }); Object.assign(g.conversation, patch);
    await assert.rejects(g.send({ text: '问题' })); assert.equal(g.calls.length, 0);
  }
  const g = fixture({ active: true });
  for (const body of [{ text: '' }, { text: 'a', attachments: ['missing'] }, { text: 'a', attachments: [123] }, { text: 'a', skills: [{}] }]) await assert.rejects(g.send(body));
  g.codex.status = 'offline'; await assert.rejects(g.send({ text: 'a' }), /尚未就绪/); assert.equal(g.calls.length, 0);
});
