import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

function drawScreen(cols, rows) {
  return `\x1b[?1049h\x1b[2J\x1b[HREADY ${cols}x${rows}\x1b[${rows};1HLAST ROW COMPLETE\x1b[?25l`;
}

async function terminalFixture() {
  const terminal = { id: 'sizing', workspaceId: 'project', title: '终端', isDefault: true, cols: 100, rows: 30 };
  const snapshot = () => ({ type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', name: 'Project', path: '/tmp' }], defaultWorkspaceId: 'project', conversations: [], terminals: [{ ...terminal, replay: drawScreen(terminal.cols, terminal.rows) }], approvals: [] });
  const resizes = [];
  const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.use(express.static('dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => {
    socket.send(JSON.stringify(snapshot()));
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type !== 'terminal/resize') return;
      resizes.push(message);
      terminal.cols = message.cols; terminal.rows = message.rows;
      socket.send(JSON.stringify({ type: 'terminal/data', id: terminal.id, data: drawScreen(terminal.cols, terminal.rows) }));
    });
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return {
    terminal, resizes, wss, url: `http://127.0.0.1:${server.address().port}`,
    async close(page) { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); },
  };
}

async function expectCompleteScreen(page) {
  const view = page.locator('.terminal-view.visible');
  await expect(view).toHaveAttribute('aria-busy', 'false');
  await expect(view.locator('.xterm-rows > div').last()).toContainText('LAST ROW COMPLETE');
  await expect.poll(() => view.evaluate(element => {
    const host = element.querySelector('.terminal-container');
    const bounds = host.getBoundingClientRect(), style = getComputedStyle(host);
    const screen = element.querySelector('.xterm-screen').getBoundingClientRect();
    const lastRow = element.querySelector('.xterm-rows > div:last-child').getBoundingClientRect();
    const bottom = bounds.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    const right = bounds.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    return Math.max(screen.bottom - bottom, lastRow.bottom - bottom, screen.right - right);
  }), { message: 'The complete final row and rightmost column must fit inside the padded terminal' }).toBeLessThanOrEqual(0.5);
}

for (const mobile of [false, true]) {
  test.describe(mobile ? 'phone terminal sizing' : 'desktop terminal sizing', () => {
    if (mobile) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    test('keeps the final terminal row visible after resizing and opening the keyboard', async ({ page }) => {
      const fixture = await terminalFixture();
      try {
        await page.goto(fixture.url);
        await page.getByRole('tab', { name: '终端', exact: true }).click();
        await expectCompleteScreen(page);
        const sizes = mobile ? [{ width: 320, height: 640 }, { width: 390, height: 400 }, { width: 844, height: 390 }] : [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }];
        for (const viewport of sizes) {
          await page.setViewportSize(viewport);
          await expectCompleteScreen(page);
          await page.getByRole('button', { name: '显示终端键盘', exact: true }).click();
          await expectCompleteScreen(page);
          await page.getByRole('button', { name: '收起终端键盘', exact: true }).click();
          await expectCompleteScreen(page);
        }
        await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
        await expectCompleteScreen(page);
        await page.screenshot({ path: `.data/harness-ui/${mobile ? 'mobile' : 'desktop'}-terminal-fit.png` });
      } finally { await fixture.close(page); }
    });
  });
}

test('resynchronizes a shared terminal on activation and after reconnect', async ({ page }) => {
  const fixture = await terminalFixture();
  try {
    await page.goto(fixture.url);
    await page.getByRole('tab', { name: '终端', exact: true }).click();
    await expect.poll(() => fixture.resizes.length).toBeGreaterThan(0);
    const localSize = { cols: fixture.terminal.cols, rows: fixture.terminal.rows };
    const before = fixture.resizes.length;
    await page.getByRole('tab', { name: 'Codex', exact: true }).click();
    // A different browser changed the shared PTY while this terminal was hidden.
    fixture.terminal.cols = 41; fixture.terminal.rows = 23;
    await page.getByRole('tab', { name: '终端', exact: true }).click();
    await expect.poll(() => fixture.resizes.length).toBe(before + 1);
    expect(fixture.resizes.at(-1)).toMatchObject(localSize);
    await expectCompleteScreen(page);
    fixture.terminal.cols = 41; fixture.terminal.rows = 23;
    const beforeFocus = fixture.resizes.length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => fixture.resizes.length).toBe(beforeFocus + 1);
    expect(fixture.resizes.at(-1)).toMatchObject(localSize);
    const beforeReconnect = fixture.resizes.length;
    fixture.terminal.cols = 41; fixture.terminal.rows = 23;
    for (const socket of fixture.wss.clients) socket.close();
    await expect.poll(() => fixture.resizes.length).toBeGreaterThan(beforeReconnect);
    expect(fixture.resizes.at(-1)).toMatchObject(localSize);
    await expectCompleteScreen(page);
  } finally { await fixture.close(page); }
});
