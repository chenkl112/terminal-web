import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

for (const scenario of [
  { name: 'plain scrollback' },
  { name: 'mouse-enabled scrollback', mouse: true },
  { name: 'fullscreen application', mouse: true, alternate: true },
  { name: 'phone touch scrollback', mouse: true, touch: true },
  { name: 'Codex after truncated replay', truncated: true },
  { name: 'phone Codex after truncated replay', truncated: true, touch: true },
]) {
  test.describe(scenario.name, () => {
    if (scenario.touch) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    test('scrolls the correct buffer without sending accidental input', async ({ page, context }) => {
      const input = [];
      const history = Array.from({ length: 200 }, (_, i) => `history row ${i}\r\n`).join('');
      const terminal = { id: 'term', title: '终端', workspaceId: 'project', isDefault: true, cols: 80, rows: 24,
        replay: scenario.truncated ? 'CODEX SCREEN' : history + (scenario.alternate ? '\x1b[?1049hAPP SCREEN' : '') + (scenario.mouse ? '\x1b[?1000h\x1b[?1006h' : '') };
      const snapshot = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', name: 'Project', path: '/tmp' }], defaultWorkspaceId: 'project', conversations: [], terminals: [terminal], approvals: [] };
      const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true })); app.use(express.static('dist'));
      const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
      wss.on('connection', socket => { socket.send(JSON.stringify(snapshot)); socket.on('message', raw => { const data = JSON.parse(raw); if (data.type === 'terminal/input') input.push(data.data); }); });
      server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`); await page.getByRole('tab', { name: '终端', exact: true }).click();
        const view = page.getByRole('region', { name: '终端', exact: true }); await expect(view).toHaveAttribute('aria-busy', 'false');
        const rows = view.locator('.xterm-rows'); await expect(rows).toContainText(scenario.truncated ? 'CODEX SCREEN' : scenario.alternate ? 'APP SCREEN' : 'history row 199');
        const initial = await rows.innerText(), screen = await view.locator('.xterm-screen').boundingBox();
        if (scenario.touch) {
          const cdp = await context.newCDPSession(page), x = screen.x + screen.width / 2, y = screen.y + 60;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 24 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2); await page.mouse.wheel(0, -500);
        }
        if (scenario.alternate || scenario.truncated) {
          await expect.poll(() => input.some(data => /\x1b\[<6[45];/.test(data))).toBe(true);
          await expect(rows).toContainText(scenario.truncated ? 'CODEX SCREEN' : 'APP SCREEN');
          expect(input.every(data => /^\x1b\[<6[45];\d+;\d+M$/.test(data))).toBe(true);
        } else {
          await expect.poll(() => rows.innerText()).not.toBe(initial); expect(input).toEqual([]);
          if (!scenario.touch) {
            const middle = await rows.innerText();
            await page.keyboard.down('Shift'); await page.mouse.wheel(0, -200); await page.keyboard.up('Shift');
            await expect.poll(() => rows.innerText()).not.toBe(middle); expect(input).toEqual([]);
            await page.mouse.wheel(0, 5000); await expect(rows).toContainText('history row 199');
          }
        }
      } finally { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); }
    });
  });
}
