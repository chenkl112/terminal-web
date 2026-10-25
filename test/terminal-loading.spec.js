import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('large terminal history yields to touch, opens once and fits phone viewports', async ({ page, context }) => {
  const replay = Array.from({ length: 22000 }, (_, i) => `\x1b[32m${String(i).padStart(5, '0')}\x1b[0m ${'terminal history '.repeat(5)}\r\n`).join('') + '\x1b[2J\x1b[HREADY 手机终端\r\n\x1b[6n';
  const terminals = ['one', 'two'].map(id => ({ id, title: id, workspaceId: 'project', cols: 41, rows: 23, replay }));
  const state = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', name: 'Project', path: '/tmp' }], defaultWorkspaceId: 'project', conversations: [], terminals, approvals: [] };
  const resizeEvents = [], inputEvents = [];
  const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.post('/api/terminals/default', (_, res) => res.json(terminals[0]));
  app.use(express.static(process.env.TERMINAL_LOADING_DIST || 'dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => {
    socket.send(JSON.stringify(state));
    socket.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'terminal/resize') resizeEvents.push(message); if (message.type === 'terminal/input') inputEvents.push(message); });
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    window.terminalLongTasks = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.terminalLongTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const first = page.getByRole('tab', { name: 'one', exact: true }); await expect(first).toBeVisible();
    await expect(page.locator('.xterm')).toHaveCount(0);
    const started = await page.evaluate(() => performance.now());
    await first.tap();
    const terminal = page.getByRole('region', { name: 'one', exact: true });
    await expect(terminal).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(terminal.locator('.xterm-rows')).toContainText('READY 手机终端');
    await expect(page.locator('.xterm')).toHaveCount(1);
    expect(inputEvents).toEqual([]);
    const longTasks = await page.evaluate(start => window.terminalLongTasks.filter(task => task.start >= start), started);
    console.log(JSON.stringify({ historyBytes: replay.length, maxLongTaskMs: Math.max(0, ...longTasks.map(task => task.duration)), resizeEvents: resizeEvents.length }));
    expect(Math.max(0, ...longTasks.map(task => task.duration))).toBeLessThan(500);
    const before = resizeEvents.length;
    for (let i = 0; i < 3; i++) {
      await page.getByRole('tab', { name: 'Codex', exact: true }).tap(); await first.tap();
      await expect(terminal).toHaveAttribute('aria-busy', 'false');
      await expect(terminal.locator('.xterm-rows')).toContainText('READY 手机终端');
    }
    expect(resizeEvents.length).toBe(before);
    await page.reload();
    await expect(terminal).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(page.locator('.welcome')).toHaveCount(0);
    await expect(terminal.locator('.xterm-rows')).toContainText('READY 手机终端');
    expect(inputEvents).toEqual([]);
    await page.getByRole('button', { name: '显示终端键盘', exact: true }).tap();
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 400 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height'))))).toBe(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      const screen = await terminal.locator('.terminal-screen').boundingBox(); expect(screen.height).toBeGreaterThan(60);
      const host = await terminal.locator('.terminal-keyboard-host').boundingBox(); expect(host.y + host.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.data/mobile-terminal-layout.png' });
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close();
  }
});
