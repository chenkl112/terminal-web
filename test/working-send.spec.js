import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createMessageSender } from '../server/messages.js';

async function harness({ questions = false } = {}) {
  const workspace = { id: 'project', name: 'Project', path: '/tmp' };
  const turn = { id: 'running', status: 'inProgress', items: [
    { id: 'original', type: 'userMessage', content: [{ type: 'text', text: '请检查项目' }] },
    { id: 'command', type: 'commandExecution', command: 'npm test', status: 'inProgress' },
  ] };
  const conversation = { id: 'chat', threadId: 'thread', workspaceId: workspace.id, cwd: workspace.path, title: '运行中发送', status: 'active', activeTurnId: turn.id, turns: [turn], attachments: {}, permissionMode: 'workspace-write', usage: { total: { totalTokens: 10000, outputTokens: 1000 } } };
  const approvals = questions ? [{ id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'thread', questions: [{ id: 'choice', header: '方案', question: '要使用哪个方案？', options: [{ label: '方案 A', description: '使用第一种方案' }, { label: '方案 B', description: '使用第二种方案' }] }] } }] : [];
  const state = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [workspace], defaultWorkspaceId: workspace.id,
    conversations: [conversation], terminals: [{ id: 'terminal', workspaceId: workspace.id, title: '终端', isDefault: true, replay: '' }], approvals };
  const calls = [], interruptions = [], loaded = []; let socket, gate = null, failure = false;
  const publish = () => socket?.send(JSON.stringify({ type: 'conversation', conversation }));
  const codex = { status: 'ready', async call(method, params) {
    calls.push({ method, params });
    if (gate) await gate;
    if (failure) throw new Error('模拟发送失败，请重试');
    turn.items.push({ id: `user-${calls.length}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input });
    return { turn: { id: turn.id, status: 'inProgress' } };
  } };
  const send = createMessageSender({ codex, state: { uploads: {} }, ensureLoaded: async () => loaded.push(true), publish, uploadCleanup: { touch() {}, markUsed() {} } });
  const app = express(); app.use(express.json()); app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.post('/api/conversations/chat/messages', async (req, res) => res.json(await send(conversation, req.body)));
  app.post('/api/conversations/chat/interrupt', (_, res) => { interruptions.push(true); res.json({ ok: true }); });
  app.use('/api', (error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  app.use(express.static('dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', ws => { socket = ws; socket.send(JSON.stringify(state)); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { conversation, turn, calls, interruptions, loaded, publish, origin: `http://127.0.0.1:${server.address().port}`,
    hold() { let release; gate = new Promise(resolve => { release = resolve; }); return () => { const done = release; gate = null; done(); }; },
    setFailure(value) { failure = value; }, close() { wss.close(); server.closeAllConnections(); server.close(); } };
}

for (const phone of [false, true]) test.describe(phone ? 'phone follow-ups' : 'desktop follow-ups', () => {
  if (phone) test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  test('questions and instructions can be sent while tools run without stopping or resetting speed', async ({ page }) => {
    const app = await harness();
    await page.addInitScript(() => { window.followupNow = 1000; performance.now = () => window.followupNow; });
    try {
      await page.goto(app.origin);
      const input = page.getByRole('textbox', { name: '发送给 Codex', exact: true });
      const send = page.getByRole('button', { name: '发送消息', exact: true }); const stop = page.getByRole('button', { name: '停止生成', exact: true });
      await expect(stop).toBeVisible(); await expect(send).toBeVisible(); await expect(send).toBeDisabled();
      await page.evaluate(() => { window.followupNow += 2000; }); app.conversation.usage.total.outputTokens += 200; app.publish();
      await expect(page.getByTestId('output-speed')).toHaveText('100.0');
      await input.fill('为什么选择这个方案？'); await expect(send).toBeEnabled(); await send.click();
      await expect(input).toHaveValue(''); await expect(page.getByText('为什么选择这个方案？', { exact: true })).toBeVisible();
      await expect(page.getByTestId('output-speed')).toHaveText('100.0');
      await input.fill('继续检查，顺便处理错误'); await input.press('Enter'); await expect(input).toHaveValue('');
      expect(app.calls.map(call => call.method)).toEqual(['turn/start', 'turn/start']); expect(app.interruptions).toEqual([]); expect(app.loaded).toEqual([]);
      expect(app.conversation.activeTurnId).toBe('running'); expect(app.turn.items.find(item => item.id === 'command').status).toBe('inProgress');
      await expect(stop).toBeVisible(); await expect(page.locator('.work-status')).toContainText('正在运行命令');
      if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      // Sending is independent from the explicit stop control.
      await stop.click(); await expect.poll(() => app.interruptions.length).toBe(1);
    } finally { await page.goto('about:blank').catch(() => {}); app.close(); }
  });
});

test('pending assistant questions do not block follow-ups; failures and in-flight edits preserve drafts', async ({ page }) => {
  const app = await harness({ questions: true }); let release;
  try {
    await page.goto(app.origin); await expect(page.getByText('要使用哪个方案？', { exact: true })).toBeVisible();
    const input = page.getByRole('textbox', { name: '发送给 Codex', exact: true }); const send = page.getByRole('button', { name: '发送消息', exact: true });
    await input.fill('先解释两个方案的差异'); release = app.hold(); await input.press('Enter');
    await expect.poll(() => app.calls.length).toBe(1); await expect(send).toBeDisabled();
    await input.press('Enter'); await input.fill('下一条补充问题'); release(); release = null;
    await expect(send).toBeEnabled(); await expect(input).toHaveValue('下一条补充问题'); expect(app.calls).toHaveLength(1);
    await expect(page.getByText('先解释两个方案的差异', { exact: true })).toBeVisible();
    app.setFailure(true); await send.click(); await expect(page.getByRole('alert')).toContainText('模拟发送失败');
    await expect(input).toHaveValue('下一条补充问题'); await expect(send).toBeEnabled();
    app.setFailure(false); await send.click(); await expect(input).toHaveValue('');
    expect(app.interruptions).toEqual([]); expect(app.loaded).toEqual([]); expect(app.calls).toHaveLength(3);
  } finally { release?.(); await page.goto('about:blank').catch(() => {}); app.close(); }
});
