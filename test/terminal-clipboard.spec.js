import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

async function withTerminal(page, clipboard, text, run) {
    const input = [];
    const terminal = { id: 'shared', workspaceId: 'project', title: '终端', isDefault: false, cols: 100, rows: 30, replay: `${text}\r\n\x1b[?1000h\x1b[?1006h` };
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
      await expect(page.locator('.terminal-view.visible')).toHaveAttribute('aria-busy', 'false');
      await run(input);
    } finally { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); }
}

async function dragRows(page, firstRow, lastRow = firstRow) {
  const first = await firstRow.boundingBox(), last = await lastRow.boundingBox();
  await page.mouse.move(first.x + 1, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 15 });
  await page.mouse.up();
}

for (const clipboard of ['native', 'unavailable', 'denied']) {
  test(`terminal copies selected Unicode text without interrupting Codex (${clipboard} clipboard)`, async ({ page }) => {
    const text = 'Clipboard 中文  keep   spaces';
    await withTerminal(page, clipboard, text, async input => {
      const row = page.locator('.terminal-view.visible .xterm-rows>div').first(); await expect(row).toContainText(text);
      const bounds = await row.boundingBox();
      const beforeDrag = input.length;
      await dragRows(page, row);
      const copy = page.getByRole('button', { name: '复制选中内容', exact: true }); await expect(copy).toBeEnabled();
      expect(input.slice(beforeDrag)).toEqual([]);
      for (const shortcut of ['Control+c', 'Control+Shift+c']) {
        await page.evaluate(() => window.__writeClipboard('sentinel'));
        const before = input.length; await page.keyboard.press(shortcut);
        await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(text);
        expect(input.slice(before)).not.toContain('\x03');
      }
      await page.evaluate(() => window.__writeClipboard('sentinel'));
      const beforeRightClick = input.length;
      await page.mouse.click(bounds.x + 15, bounds.y + bounds.height / 2, { button: 'right' });
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(text);
      await expect(copy).toBeEnabled();
      expect(input.slice(beforeRightClick)).toEqual([]);
      await page.evaluate(() => window.__writeClipboard('sentinel')); await page.keyboard.press('Control+c');
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(text);
      await page.evaluate(() => window.__writeClipboard('sentinel')); await copy.click();
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(text);
      await expect(page.locator('.terminal-copy-tools [role=status]')).toHaveText('已复制');
      await page.mouse.click(bounds.x + 3, bounds.y + bounds.height / 2); await expect(copy).toBeDisabled();
      await page.keyboard.press('Control+c'); await expect.poll(() => input.filter(value => value === '\x03').length).toBe(1);
      const before = input.length; await page.keyboard.press('Control+Shift+c');
      await expect(page.locator('.terminal-copy-tools [role=status]')).toHaveText('请先选择文字后复制'); expect(input.length).toBe(before);
      await page.evaluate(() => window.__writeClipboard('sentinel'));
      const nativeContextMenu = await row.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return element.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, clientX: bounds.x + 15, clientY: bounds.y + bounds.height / 2,
        }));
      });
      expect(nativeContextMenu).toBe(true);
      expect(await page.evaluate(() => window.__readClipboard())).toBe('sentinel');

      const beforeDoubleClick = input.length;
      await page.mouse.dblclick(bounds.x + 22, bounds.y + bounds.height / 2);
      await expect(copy).toBeEnabled(); await page.keyboard.press('Control+c');
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe('Clipboard');
      expect(input.slice(beforeDoubleClick)).toEqual([]);

      await page.mouse.click(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2); await expect(copy).toBeDisabled();
      const beforeModifiedClick = input.length;
      await page.keyboard.down('Control');
      await page.mouse.click(bounds.x + 22, bounds.y + bounds.height / 2);
      await page.keyboard.up('Control');
      await expect.poll(() => input.slice(beforeModifiedClick).join('')).toMatch(/\x1b\[<16;\d+;\d+M/);
    });
  });
}

test('ordinary terminal drag preserves wrapped lines, CJK characters and explicit newlines', async ({ page }) => {
  const wrapped = '连续输出 中文  keep   spaces '.repeat(12).trimEnd(), finalLine = 'Second line 中文  end';
  await withTerminal(page, 'native', `${wrapped}\r\n${finalLine}`, async input => {
    const rows = page.locator('.terminal-view.visible .xterm-rows>div');
    const finalRow = rows.filter({ hasText: finalLine });
    await expect(finalRow).toHaveCount(1);
    await dragRows(page, rows.first(), finalRow);
    const copy = page.getByRole('button', { name: '复制选中内容', exact: true }); await expect(copy).toBeEnabled();
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(`${wrapped}\n${finalLine}`);
    expect(input).toEqual([]);
  });
});
