import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

for (const phone of [false, true]) test.describe(phone ? 'phone chat scrolling' : 'desktop chat scrolling', () => {
  if (phone) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('opens at latest messages after history and images load, preserves deliberate reading, resets on reopen', async ({ page }) => {
    const workspace = { id: 'project', name: 'Project', path: '/tmp' };
    const turn = (prefix, image = false) => ({ id: 'turn', status: 'completed', items: [
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: `${Array.from({ length: 90 }, (_, i) => `${prefix} paragraph ${i}`).join('\n\n')}${image ? '\n\n![late image](http://image.test/late.svg)' : ''}\n\n${prefix} LATEST` },
    ] });
    const a = { id: 'a', threadId: 'thread-a', workspaceId: workspace.id, cwd: workspace.path, title: '会话 A', status: 'idle', turns: [turn('A', true)], attachments: {}, createdAt: 1 };
    const b = { id: 'b', threadId: 'thread-b', workspaceId: workspace.id, cwd: workspace.path, title: '会话 B', nativeHistory: true, status: 'idle', turns: [], attachments: {}, createdAt: 2 };
    const state = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [workspace], defaultWorkspaceId: workspace.id, conversations: [a, b], terminals: [{ id: 'terminal', isDefault: true, title: '终端', workspaceId: workspace.id, replay: 'terminal ready' }], approvals: [] };
    const app = express(); app.use(express.json()); app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
    let releaseHistory; const historyGate = new Promise(resolve => { releaseHistory = resolve; });
    app.post('/api/history/open', async (_, res) => { await historyGate; b.turns = [turn('B')]; res.json({ conversation: b, workspace }); });
    app.use(express.static('dist'));
    const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', socket => socket.send(JSON.stringify(state)));
    server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    let releaseImage; const imageGate = new Promise(resolve => { releaseImage = resolve; });
    await page.route('http://image.test/late.svg', async route => {
      await imageGate; await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="1000"><rect width="100" height="1000" fill="gray"/></svg>' });
    });
    const scroller = page.locator('.message-scroller');
    const gap = () => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    async function select(title) {
      if (!await page.getByRole('button', { name: title, exact: true }).isVisible()) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
      await page.getByRole('button', { name: title, exact: true }).click();
    }
    async function scrollUp() {
      const box = await scroller.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -1600);
      await expect.poll(gap).toBeGreaterThan(500);
    }
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await expect(page.getByText('A LATEST', { exact: true })).toBeInViewport(); await expect.poll(gap).toBeLessThan(3);
      releaseImage(); const image = page.locator('.markdown img'); await expect.poll(() => image.evaluate(element => element.naturalHeight)).toBe(1000);
      await expect.poll(gap).toBeLessThan(3);
      await scrollUp(); const top = await scroller.evaluate(element => element.scrollTop);
      a.turns[0].items.push({ id: 'stream', type: 'agentMessage', text: 'New streamed message\n\n'.repeat(30) });
      for (const socket of wss.clients) socket.send(JSON.stringify({ type: 'conversation', conversation: a }));
      await expect(page.getByText('New streamed message', { exact: true })).toHaveCount(30);
      expect(Math.abs(await scroller.evaluate(element => element.scrollTop) - top)).toBeLessThan(10);
      await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
      await select('会话 B'); releaseHistory(); await expect(page.getByText('B LATEST', { exact: true })).toBeInViewport(); await expect.poll(gap).toBeLessThan(3);
      await select('会话 A'); await expect.poll(gap).toBeLessThan(3);
      await scrollUp(); await page.getByRole('tab', { name: '终端', exact: true }).click(); await page.getByRole('tab', { name: 'Codex', exact: true }).click(); await expect.poll(gap).toBeLessThan(3);
      await scrollUp(); await page.reload(); await expect.poll(gap).toBeLessThan(3); await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toHaveCount(0);
      await scrollUp(); await page.getByRole('button', { name: '回到最新消息', exact: true }).click(); await expect.poll(gap).toBeLessThan(3);
    } finally { releaseImage(); releaseHistory(); await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); }
  });
});
