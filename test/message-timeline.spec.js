import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

async function harness() {
  const workspace = { id: 'project', name: 'Project', path: '/tmp' };
  const turn = { id: 'turn', status: 'inProgress', items: [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '先检查配置' }] },
    { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: '再帮我修复问题' }] },
    { id: 'c1', type: 'agentMessage', phase: 'commentary', text: '我先查看配置文件。' },
    { id: 'c2', type: 'agentMessage', phase: 'commentary', text: '已经定位到配置入口。' },
    { id: 'r', type: 'reasoning', summary: ['检查配置与运行参数是否一致。'] },
    { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'inProgress', aggregatedOutput: 'CHECK_OUTPUT' },
    { id: 'c3', type: 'agentMessage', phase: 'commentary', text: '测试已经开始。' },
    { id: 'c4', type: 'agentMessage', phase: 'commentary', text: '正在验证修改结果。' },
  ] };
  const conversation = { id: 'chat', threadId: 'native', title: '消息展示测试', workspaceId: workspace.id, cwd: workspace.path, status: 'active', activeTurnId: turn.id, attachments: {}, turns: [turn] };
  const state = { type: 'snapshot', codexStatus: 'ready', workspaces: [workspace], defaultWorkspaceId: workspace.id, models: [], conversations: [conversation], terminals: [{ id: 'terminal', title: '终端', isDefault: true, workspaceId: workspace.id, replay: 'CLI stays unchanged' }], approvals: [] };
  const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true })); app.use(express.static('dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' }); let socket;
  wss.on('connection', ws => { socket = ws; socket.send(JSON.stringify(state)); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { conversation, turn, origin: `http://127.0.0.1:${server.address().port}`,
    update() { socket.send(JSON.stringify({ type: 'conversation', conversation })); },
    close() { wss.close(); server.closeAllConnections(); server.close(); } };
}

test('web messages stack consecutive updates, keep process details and expansion stable, and share final reply chrome', async ({ page }) => {
  const app = await harness(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copiedReply = text; } } }); });
  try {
    await page.goto(app.origin);
    const users = page.locator('.user-message-history'); await expect(users).toContainText('2 条连续消息'); await expect(users).not.toHaveAttribute('open');
    await expect(page.getByText('先检查配置', { exact: true })).toBeHidden(); await expect(page.getByText('再帮我修复问题', { exact: true })).toBeVisible();
    await users.locator(':scope>summary').click(); await expect(page.getByText('先检查配置', { exact: true })).toBeVisible();
    const process = page.locator('.process-disclosure'); await expect(process).toHaveCount(1); await expect(process).not.toHaveAttribute('open');
    await expect(process.locator(':scope>summary')).toContainText('正在处理'); await expect(process.locator('.process-preview')).toHaveText('正在验证修改结果。');
    await expect(page.getByText('CHECK_OUTPUT', { exact: true })).toHaveCount(0);
    await process.locator(':scope>summary').click(); const stacks = process.locator('.message-stack'); await expect(stacks).toHaveCount(2);
    await expect(stacks.first()).not.toHaveAttribute('open'); await expect(stacks.first().locator(':scope>summary')).toContainText('2 条过程消息');
    await expect(page.getByText('我先查看配置文件。', { exact: true })).toHaveCount(0);
    await stacks.first().locator(':scope>summary').click(); await expect(page.getByText('我先查看配置文件。', { exact: true })).toBeVisible();
    await process.locator('.tool-activity>summary').click(); await expect(page.getByText('CHECK_OUTPUT', { exact: true })).toBeVisible();
    // New process messages retain the open outer group, nested stack and command.
    app.turn.items.push({ id: 'c5', type: 'agentMessage', phase: 'commentary', text: '验证接近完成。' }); app.update();
    await expect(process).toHaveAttribute('open'); await expect(stacks.first()).toHaveAttribute('open');
    await expect(stacks.last().locator(':scope>summary')).toContainText('3 条过程消息'); await expect(page.getByText('CHECK_OUTPUT', { exact: true })).toBeVisible();
    app.turn.items.find(item => item.id === 'cmd').status = 'completed'; app.turn.items.find(item => item.id === 'cmd').exitCode = 0;
    app.turn.items.push({ id: 'a1', type: 'agentMessage', phase: 'final_answer', text: '配置问题已经修复。' }, { id: 'a2', type: 'agentMessage', phase: 'final_answer', text: '测试全部通过。' });
    app.turn.status = 'completed'; app.conversation.status = 'idle'; app.conversation.activeTurnId = null; app.update();
    await expect(process.locator(':scope>summary')).toContainText('已完成'); await expect(process).toHaveAttribute('open');
    await expect(page.locator('.assistant-run')).toHaveCount(1); await expect(page.locator('.assistant-run>.agent-label')).toHaveCount(1);
    await expect(page.getByText('配置问题已经修复。', { exact: true })).toBeVisible(); await expect(page.getByText('测试全部通过。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '复制回复', exact: true }).click(); await expect.poll(() => page.evaluate(() => window.__copiedReply)).toBe('配置问题已经修复。\n\n测试全部通过。');
    // Refresh starts folded again, while final answers remain available.
    await page.reload(); await expect(process).not.toHaveAttribute('open'); await expect(page.getByText('测试全部通过。', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); app.close(); }
});

test('phone message stacks remain readable, show failures when collapsed and do not overflow', async ({ browser }) => {
  const app = await harness(); app.turn.status = 'completed'; app.conversation.status = 'idle'; app.conversation.activeTurnId = null;
  Object.assign(app.turn.items.find(item => item.id === 'cmd'), { status: 'failed', exitCode: 1 });
  app.turn.items.push({ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '检查发现一处配置问题，需要修正。' });
  const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } }), page = await context.newPage();
  try {
    await page.goto(app.origin); const process = page.locator('.process-disclosure'); await expect(process.locator(':scope>summary')).toContainText('1 项失败');
    await process.locator(':scope>summary').tap(); await process.locator('.message-stack').first().locator(':scope>summary').tap();
    await expect(page.getByText('我先查看配置文件。', { exact: true })).toBeVisible();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      const box = await process.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: '.data/message-timeline-phone.png', fullPage: true });
  } finally { await context.close(); app.close(); }
});
