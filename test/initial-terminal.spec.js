import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { terminalManager, terminalInfo } from '../server/terminals.js';

test('different browsers share one undeletable Codex terminal, including refresh, reconnect and restart', async ({ page, browser }) => {
  const terminals = new Map(), children = [], input = [];
  const workspaces = [{ id: 'project', name: 'Project', path: '/tmp' }];
  const snapshot = () => ({ type: 'snapshot', codexStatus: 'ready', models: [], workspaces, defaultWorkspaceId: 'project', conversations: [{ id: 'chat', workspaceId: 'project', title: '聊天', status: 'idle', turns: [], attachments: {} }], terminals: [...terminals.values()].map(t => ({ ...terminalInfo(t), replay: t.replay })), approvals: [] });
  const app = express(); app.use(express.json());
  app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  const broadcast = event => { for (const socket of wss.clients) socket.send(JSON.stringify(event)); };
  const manager = terminalManager({ state: { workspaces }, defaultWorkspaceId: 'project', terminals, broadcast, spawn() {
    const child = { onData(fn) { this.output = fn; }, onExit(fn) { this.exit = fn; }, write(data) { input.push(data); this.output(data); }, resize() {}, kill() {} };
    children.push(child); return child;
  } });
  app.use('/api/terminals', manager.router);
  app.use(express.static(process.env.TERMINAL_TEST_DIST || 'dist'));
  wss.on('connection', socket => { socket.send(JSON.stringify(snapshot())); socket.on('message', raw => {
    const message = JSON.parse(raw); if (message.type === 'terminal/input') terminals.get(message.id)?.pty.write(message.data);
  }); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const otherContext = await browser.newContext(), other = await otherContext.newPage();
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await Promise.all([page.goto(origin), other.goto(origin)]);
    const tab = page.getByRole('tab', { name: '终端', exact: true });
    const chat = page.getByRole('tab', { name: 'Codex', exact: true });
    await expect(chat).toHaveAttribute('aria-selected', 'true');
    await expect(other.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(children).toHaveLength(1); expect(terminals.size).toBe(1); expect(input).toHaveLength(0);
    await expect(page.getByRole('button', { name: '关闭 终端', exact: true })).toHaveCount(0);
    const id = [...terminals.keys()][0];
    expect((await page.request.delete(`${origin}/api/terminals/${id}`)).status()).toBe(403);
    await tab.click(); await other.getByRole('tab', { name: '终端', exact: true }).click();
    children[0].output('shared terminal output\r\n');
    await expect(page.locator('.terminal-view.visible .xterm-screen')).toContainText('shared terminal output');
    await expect(other.locator('.terminal-view.visible .xterm-screen')).toContainText('shared terminal output');
    await page.reload(); await expect(page.getByRole('tab', { name: '终端', exact: true })).toHaveAttribute('aria-selected', 'true'); expect(children).toHaveLength(1);
    await chat.click();
    await page.reload(); await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const socket of wss.clients) socket.close();
    await expect(page.locator('.connection-banner').first()).toBeVisible();
    await expect(page.locator('.connection-banner')).toHaveCount(0);
    await expect(chat).toHaveAttribute('aria-selected', 'true'); expect(children).toHaveLength(1);
    children[0].exit({ exitCode: 0 });
    await other.getByRole('button', { name: '重新打开 Codex', exact: true }).click();
    await expect(other.getByRole('button', { name: '重新打开 Codex', exact: true })).toHaveCount(0);
    expect(children).toHaveLength(2); expect([...terminals.keys()]).toEqual([id]);
    await other.reload(); await expect(other.getByRole('tab', { name: '终端', exact: true })).toHaveAttribute('aria-selected', 'true'); expect(children).toHaveLength(2);
  } finally { await page.goto('about:blank'); await otherContext.close(); wss.close(); server.closeAllConnections(); server.close(); }
});
