import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

for (const clipboard of ['native', 'unavailable', 'denied']) {
  test(`terminal copies selected Unicode text without interrupting Codex (${clipboard} clipboard)`, async ({ page }) => {
    const input = [], text = 'Clipboard 中文  keep   spaces';
    const terminal = { id: 'shared', workspaceId: 'project', title: '终端', isDefault: true, cols: 100, rows: 30, replay: `${text}\r\n\x1b[?1000h\x1b[?1006h` };
    const snapshot = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', name: 'Project', path: '/tmp' }], defaultWorkspaceId: 'project', conversations: [], terminals: [terminal], approvals: [] };
    const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
    app.use(express.static(process.env.CLIPBOARD_TEST_DIST || 'dist'));
    const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', socket => { socket.send(JSON.stringify(snapshot)); socket.on('message', raw => {
      const message = JSON.parse(raw); if (message.type === 'terminal/input') input.push(message.data);
    }); });
    server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await page.addInitScript(mode => {
      window.__readClipboard = navigator.clipboard.readText.bind(navigator.clipboard);
      window.__writeClipboard = navigator.clipboard.writeText.bind(navigator.clipboard);
      if (mode === 'unavailable') Object.defineProperty(navigator, 'clipboard', { value: undefined });
      if (mode === 'denied') Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } });
    }, clipboard);
    try {
      await page.goto(origin);
      const terminalTab = page.getByRole('tab', { name: '终端', exact: true }); await terminalTab.click();
      await expect(terminalTab).toHaveAttribute('aria-selected', 'true');
      const row = page.locator('.terminal-view.visible .xterm-rows>div').first(); await expect(row).toContainText(text);
      const bounds = await row.boundingBox();
      await page.keyboard.down('Shift'); await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 15 }); await page.mouse.up(); await page.keyboard.up('Shift');
      const copy = page.getByRole('button', { name: '复制选中内容', exact: true }); await expect(copy).toBeEnabled();
      for (const shortcut of ['Control+c', 'Control+Shift+c']) {
        await page.evaluate(() => window.__writeClipboard('sentinel'));
        const before = input.length; await page.keyboard.press(shortcut);
        await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(text);
        expect(input.slice(before)).not.toContain('\x03');
      }
      await page.evaluate(() => window.__writeClipboard('sentinel')); await copy.click();
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(text);
      await expect(page.locator('.terminal-copy-tools [role=status]')).toHaveText('已复制');
      await page.mouse.click(bounds.x + 3, bounds.y + bounds.height / 2); await expect(copy).toBeDisabled();
      await page.keyboard.press('Control+c'); await expect.poll(() => input.filter(value => value === '\x03').length).toBe(1);
      const before = input.length; await page.keyboard.press('Control+Shift+c');
      await expect(page.locator('.terminal-copy-tools [role=status]')).toHaveText('请先选择文字后复制'); expect(input.length).toBe(before);
    } finally { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); }
  });
}
