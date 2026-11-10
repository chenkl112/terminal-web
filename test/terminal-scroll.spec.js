import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

for (const scenario of [
  { name: 'plain scrollback' },
  { name: 'Shift wheel accesses mouse-enabled local scrollback', mouse: true, shift: true },
  { name: 'fullscreen application', mouse: true, alternate: true },
  { name: 'phone touch scrollback', touch: true },
  { name: 'Codex after truncated replay', truncated: true },
  { name: 'phone Codex after truncated replay', truncated: true, touch: true },
]) {
  test.describe(scenario.name, () => {
    if (scenario.touch) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    test('scrolls the correct buffer without sending accidental input', async ({ page, context }) => {
      const input = [];
      const history = Array.from({ length: 200 }, (_, i) => `history row ${i}\r\n`).join('');
      const terminal = { id: 'term', title: '终端', workspaceId: 'project', isDefault: !!scenario.truncated, cols: 80, rows: 24,
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
          await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2);
          if (scenario.shift) await page.keyboard.down('Shift');
          await page.mouse.wheel(0, -500);
          if (scenario.shift) await page.keyboard.up('Shift');
        }
        if (scenario.alternate || scenario.truncated) {
          await expect.poll(() => input.some(data => /\x1b\[<6[45];/.test(data))).toBe(true);
          await expect(rows).toContainText(scenario.truncated ? 'CODEX SCREEN' : 'APP SCREEN');
          expect(input.every(data => /^(?:\x1b\[<6[45];\d+;\d+M)+$/.test(data))).toBe(true);
        } else {
          await expect.poll(() => rows.innerText()).not.toBe(initial); expect(input).toEqual([]);
          if (!scenario.touch) {
            const middle = await rows.innerText();
            await page.keyboard.down('Shift'); await page.mouse.wheel(0, -200); await page.keyboard.up('Shift');
            await expect.poll(() => rows.innerText()).not.toBe(middle); expect(input).toEqual([]);
            if (scenario.shift) await page.keyboard.down('Shift');
            await page.mouse.wheel(0, 5000);
            if (scenario.shift) await page.keyboard.up('Shift');
            await expect(rows).toContainText('history row 199'); expect(input).toEqual([]);
          }
        }
      } finally { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); }
    });
  });
}

async function shortHistoryApplication(mouseReporting, manualCodex = false) {
  const input = [], resizes = [];
  let position = 0;
  const terminal = { id: 'inline', title: '终端', workspaceId: 'project', isDefault: !manualCodex, cols: 80, rows: 24 };
  const renderPosition = () => `\x1b[H\x1b[2KOLDER row ${position}`;
  const replay = () => '\x1b[2J\x1b[3J\x1b[H'
    + Array.from({ length: terminal.rows + 3 }, (_, index) => `local row ${index}\r\n`).join('')
    + renderPosition() + (mouseReporting ? '\x1b[?1000h\x1b[?1006h' : '')
    + (manualCodex ? '\x1b]7501;state=idle:app=codex\x07' : '');
  const snapshot = () => ({ type: 'snapshot', codexStatus: 'ready', models: [],
    workspaces: [{ id: 'project', name: 'Project', path: '/tmp' }], defaultWorkspaceId: 'project',
    conversations: [], terminals: [{ ...terminal, replay: replay() }], approvals: [] });
  const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true })); app.use(express.static('dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => {
    socket.send(JSON.stringify(snapshot()));
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'terminal/resize') {
        resizes.push(message); terminal.cols = message.cols; terminal.rows = message.rows;
        socket.send(JSON.stringify({ type: 'terminal/data', id: terminal.id, data: replay() }));
      } else if (message.type === 'terminal/input') {
        input.push(message.data);
        for (const match of message.data.matchAll(/\x1b\[<(64|65);\d+;(\d+)M/g)) {
          // Real Codex does not scroll the transcript when a wheel hits its footer.
          if (Number(match[2]) < terminal.rows - 4) position += match[1] === '64' ? 1 : -1;
        }
        socket.send(JSON.stringify({ type: 'terminal/data', id: terminal.id, data: renderPosition() }));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { input, resizes, get position() { return position; }, url: `http://127.0.0.1:${server.address().port}`,
    async close(page) { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); } };
}

for (const mouseReporting of [true, false]) {
  for (const touch of [false, true]) {
    test.describe(`inline Codex ${mouseReporting ? 'with mouse reporting' : 'with truncated mouse mode'} / ${touch ? 'phone' : 'desktop'}`, () => {
      if (touch) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      test('continues scrolling application history beyond short local scrollback and after refresh', async ({ page, context }) => {
        const fixture = await shortHistoryApplication(mouseReporting);
        const cdp = touch ? await context.newCDPSession(page) : null;
        try {
          await page.goto(fixture.url);
          for (const refreshed of [false, true]) {
            const previousResizes = fixture.resizes.length;
            if (refreshed) await page.reload();
            await page.getByRole('tab', { name: '终端', exact: true }).click();
            const view = page.getByRole('region', { name: '终端', exact: true });
            await expect(view).toHaveAttribute('aria-busy', 'false');
            await expect.poll(() => fixture.resizes.length).toBeGreaterThan(previousResizes);
            const rows = view.locator('.xterm-rows');
            await expect(rows).toContainText(`OLDER row ${fixture.position}`);
            const screen = await view.locator('.xterm-screen').boundingBox();
            const x = screen.x + screen.width / 2, y = touch ? screen.y + screen.height / 2 : screen.y + screen.height - 4;
            if (!touch) await page.mouse.move(x, y);

            async function scroll(direction) {
              if (!touch) { await page.mouse.wheel(0, direction * 120); return; }
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
              for (let step = 1; step <= 5; step++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - direction * step * 22 }] });
              }
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            }

            for (let gesture = 0; gesture < 6; gesture++) {
              const previousPosition = fixture.position;
              await scroll(-1);
              await expect.poll(() => fixture.position).toBeGreaterThan(previousPosition);
              await expect.poll(async () => (await rows.innerText()).includes(`OLDER row ${fixture.position}`)).toBe(true);
            }
            expect(fixture.position).toBeGreaterThan(3);
            const olderPosition = fixture.position;
            await scroll(1);
            await expect.poll(() => fixture.position).toBeLessThan(olderPosition);
            await expect.poll(async () => (await rows.innerText()).includes(`OLDER row ${fixture.position}`)).toBe(true);
            expect(fixture.input.every(data => /^(?:\x1b\[<6[45];\d+;\d+M)+$/.test(data))).toBe(true);
          }
        } finally { await fixture.close(page); }
      });
    });
  }
}

test('Codex started inside a shell keeps scrolling after startup modes disappear from replay', async ({ page }) => {
  const fixture = await shortHistoryApplication(false, true);
  try {
    await page.goto(fixture.url); await page.getByRole('tab', { name: '终端', exact: true }).click();
    const view = page.getByRole('region', { name: '终端', exact: true }); await expect(view).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => fixture.resizes.length).toBeGreaterThan(0);
    const screen = await view.locator('.xterm-screen').boundingBox();
    await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height - 4);
    await page.mouse.wheel(0, -120); await expect.poll(() => fixture.position).toBeGreaterThan(0);
    const before = fixture.position; await page.reload(); await expect(view).toHaveAttribute('aria-busy', 'false');
    await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height - 4);
    await page.mouse.wheel(0, -120); await expect.poll(() => fixture.position).toBeGreaterThan(before);
  } finally { await fixture.close(page); }
});
