import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

test('output speed measures real usage increments, stays per conversation and fits phones', async ({ page }) => {
  const workspace = { id: 'project', name: 'Project', path: '/tmp' };
  const a = { id: 'a', title: '任务 A', workspaceId: workspace.id, cwd: workspace.path, status: 'idle', turns: [], attachments: {}, usage: { total: { totalTokens: 100000, outputTokens: 10000 } } };
  const b = { ...a, id: 'b', title: '任务 B', usage: null };
  const state = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [workspace], defaultWorkspaceId: workspace.id, conversations: [a, b], terminals: [{ id: 'terminal', title: '终端', workspaceId: workspace.id, isDefault: true, replay: '' }], approvals: [] };
  const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true })); app.use(express.static('dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' }); let socket;
  wss.on('connection', ws => { socket = ws; ws.send(JSON.stringify(state)); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  await page.addInitScript(() => {
    window.speedNow = 0;
    Object.defineProperty(performance, 'now', { value: () => window.speedNow });
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const send = () => socket.send(JSON.stringify({ type: 'conversation', conversation: a }));
  const sendPatch = () => {
    const { turns, ...conversation } = a;
    socket.send(JSON.stringify({ type: 'conversation/updated', conversation, turns: [turns.at(-1)] }));
  };
  const speed = page.getByTestId('output-speed');
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(speed).toHaveText('—');
    a.status = 'active'; a.activeTurnId = 'first';
    a.turns = [{ id: 'first', status: 'inProgress', items: [{ id: 'command', type: 'commandExecution', command: 'npm test', status: 'inProgress' }] }];
    send(); await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible();
    await page.evaluate(() => { window.speedNow += 2000; });
    a.usage.total.outputTokens = 10200;
    Object.assign(a.turns[0].items[0], { status: 'completed', durationMs: 2000 });
    a.turns[0].items.push({ id: 'answer', type: 'agentMessage', text: 'First response' });
    send(); await expect(speed).toHaveText('100.0');
    await page.getByRole('button', { name: '查看会话统计', exact: true }).click();
    const details = page.getByRole('region', { name: '会话统计', exact: true });
    await expect(details).toContainText('1 轮 1 步'); await expect(details.locator('.usage-row')).toHaveCount(4);
    await expect(details.locator('.usage-row').filter({ hasText: '模型用时' })).toContainText('0秒');
    await expect(details.locator('.usage-row').filter({ hasText: '工具调用用时' })).toContainText('2秒');
    await expect(details.locator('.usage-row').filter({ hasText: 'TTFT' })).toContainText('2秒');
    await page.keyboard.press('Escape');
    a.status = 'idle'; a.activeTurnId = null; a.turns[0].status = 'completed'; send(); await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    await page.reload(); await expect(speed).toHaveText('100.0');
    await page.getByRole('button', { name: '任务 B', exact: true }).click(); await expect(speed).toHaveText('—');
    await page.getByRole('button', { name: '任务 A', exact: true }).click(); await expect(speed).toHaveText('100.0');
    a.status = 'active'; a.activeTurnId = 'second'; a.turns.push({ id: 'second', status: 'inProgress', items: [] }); sendPatch(); await expect(speed).toHaveText('—');
    await page.evaluate(() => { window.speedNow += 1000; }); a.usage.total.outputTokens = 10450; sendPatch(); await expect(speed).toHaveText('250.0');
    await expect(page.getByText('First response', { exact: true })).toBeVisible();
    socket.send(JSON.stringify(state)); await expect(speed).toHaveText('—');
    await page.evaluate(() => { window.speedNow += 1000; }); a.usage.total.outputTokens = 10550; send(); await expect(speed).toHaveText('100.0');
    const contextBounds = await page.getByRole('button', { name: '查看 token 和上下文用量', exact: true }).boundingBox();
    const speedBounds = await page.getByRole('button', { name: '查看会话统计', exact: true }).boundingBox();
    expect(Math.abs(speedBounds.y - contextBounds.y)).toBeLessThan(3);
    expect(speedBounds.x - contextBounds.x - contextBounds.width).toBeLessThan(25);
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.getByRole('button', { name: '收起侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await expect(page.locator('.session-step-summary')).toBeVisible();
    const phoneButton = await page.getByRole('button', { name: '查看会话统计', exact: true }).boundingBox(); expect(phoneButton.x + phoneButton.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 320, height: 740 });
    if (await page.getByRole('button', { name: '收起侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await page.getByRole('button', { name: '查看会话统计', exact: true }).click(); await expect(details).toContainText('中途观测');
    const bounds = await details.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    const button = await page.getByRole('button', { name: '查看会话统计', exact: true }).boundingBox(); expect(button.x + button.width).toBeLessThanOrEqual(320);
    await page.screenshot({ path: '.data/output-speed-mobile.png' }); expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); }
});
