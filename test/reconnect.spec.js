import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

test('repeated 1013 closes increase retry delay even when each websocket opens successfully', async ({ page }) => {
  const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true })); app.use(express.static('dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  const workspace = { id: 'project', name: 'Project', path: '/tmp' };
  let connections = 0, current;
  wss.on('connection', socket => {
    connections++; current = socket;
    socket.send(JSON.stringify({ type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [workspace], defaultWorkspaceId: workspace.id, conversations: [], terminals: [{ id: 'terminal', isDefault: true, workspaceId: workspace.id, title: '终端', replay: '' }], approvals: [] }));
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  await page.clock.install();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`); await expect.poll(() => connections).toBe(1);
    current.close(1013, 'backpressure'); await expect(page.locator('.connection-banner')).toHaveCount(1);
    await page.clock.fastForward(3100); await expect.poll(() => connections).toBe(2); await expect(page.locator('.connection-banner')).toHaveCount(0);
    current.close(1013, 'backpressure'); await expect(page.locator('.connection-banner')).toHaveCount(1);
    await page.clock.fastForward(3100); expect(connections).toBe(2);
    await page.clock.fastForward(3100); await expect.poll(() => connections).toBe(3);
  } finally { await page.goto('about:blank'); for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); server.close(); }
});
