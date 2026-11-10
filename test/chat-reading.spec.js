import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

for (const phone of [false, true]) test.describe(phone ? 'touch reading during output' : 'wheel reading during output', () => {
  if (phone) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('small upward scroll stays paused and statistics popovers do not block reading', async ({ page, context }) => {
    const workspace = { id: 'w', name: 'Project', path: '/tmp' };
    const answer = { id: 'answer', type: 'agentMessage', text: Array.from({ length: 120 }, (_, i) => `History paragraph ${i}`).join('\n\n') };
    const conversation = { id: 'c', title: 'Reading', workspaceId: 'w', cwd: '/tmp', status: 'active', activeTurnId: 'turn', turns: [{ id: 'turn', status: 'inProgress', items: [answer] }], attachments: {} };
    const snapshot = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [workspace], defaultWorkspaceId: 'w', conversations: [conversation], terminals: [{ id: 'terminal', isDefault: true, workspaceId: 'w', title: '终端', replay: '' }], approvals: [] };
    const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true })); app.use(express.static('dist'));
    const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' }); let socket;
    wss.on('connection', ws => { socket = ws; ws.send(JSON.stringify(snapshot)); });
    server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const scroller = page.locator('.message-scroller');
    const gap = () => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    let step = 0;
    async function output(deferred = false) {
      const text = `Streaming chunk ${++step}`; answer.text += `\n\n${text}`;
      conversation.title = text;
      socket.send(JSON.stringify({ type: 'conversation', conversation })); await expect(page.locator('.header-title')).toHaveText(text);
      if (!deferred) await expect(scroller.getByText(text, { exact: true })).toHaveCount(1);
    }
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.getByText('History paragraph 119', { exact: true })).toHaveCount(1); await expect.poll(gap).toBeLessThan(3);
      await page.getByRole('button', { name: '查看会话统计', exact: true }).click(); await expect(page.getByRole('region', { name: '会话统计', exact: true })).toBeVisible();
      const box = await scroller.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
      if (phone) {
        const cdp = await context.newCDPSession(page), beforeTouch = await scroller.evaluate(element => element.scrollTop);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await output(true);
        await expect(scroller.getByText('Streaming chunk 1', { exact: true })).toHaveCount(0);
        expect(Math.abs(await scroller.evaluate(element => element.scrollTop) - beforeTouch)).toBeLessThan(3);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await expect(scroller.getByText('Streaming chunk 1', { exact: true })).toHaveCount(1); await expect.poll(gap).toBeLessThan(3);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (const distance of [5, 12, 25, 40]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(x, y); await page.mouse.wheel(0, -24);
        await expect.poll(gap).toBeGreaterThan(5); expect(await gap()).toBeLessThan(100);
      }
      await expect(page.getByRole('region', { name: '会话统计', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
      const before = await scroller.evaluate(element => element.scrollTop);
      for (let i = 0; i < 12; i++) await output();
      expect(await gap()).toBeGreaterThan(100);
      expect(await scroller.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(before + 3);
      await page.getByRole('button', { name: '回到最新消息', exact: true }).click(); await expect.poll(gap).toBeLessThan(3);
      await output(); await expect.poll(gap).toBeLessThan(3);
    } finally { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); }
  });
});
