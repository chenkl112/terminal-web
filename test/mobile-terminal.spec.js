import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('phone terminal keyboard sends real key sequences, handles Chinese text and fits the visible viewport', async ({ page }) => {
  const input = [];
  const terminal = { id: 'shared', workspaceId: 'project', title: '终端', isDefault: true, cols: 100, rows: 30, replay: 'Mobile terminal 中文\r\n\x1b[?2004h\x1b[?1h' };
  const state = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', name: 'Project', path: '/tmp' }], defaultWorkspaceId: 'project', conversations: [], terminals: [terminal], approvals: [] };
  const app = express(); app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.use(express.static(process.env.MOBILE_TEST_DIST || 'dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => { socket.send(JSON.stringify(state)); socket.on('message', raw => { const data = JSON.parse(raw); if (data.type === 'terminal/input') input.push(data.data); }); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('tab', { name: '终端', exact: true }).tap();
    const keyboard = page.getByRole('group', { name: '终端输入键盘', exact: true }); await expect(keyboard).toBeHidden();
    await page.getByRole('button', { name: '显示终端键盘', exact: true }).tap(); await expect(keyboard).toBeVisible();
    await expect(page.locator('.terminal-view.visible .xterm-rows')).toContainText('Mobile terminal 中文');
    async function press(name, sequence) {
      const before = input.length; await keyboard.getByRole('button', { name, exact: true }).tap();
      await expect.poll(() => input.length).toBe(before + 1); expect(input.at(-1)).toBe(sequence);
    }
    await press('终端 Escape', '\x1b'); await press('终端 Tab', '\t'); await press('终端 ArrowUp', '\x1bOA');
    await keyboard.getByRole('button', { name: '终端 ctrl', exact: true }).tap();
    await expect(keyboard.getByRole('button', { name: '终端 ctrl', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await press('终端 C', '\x03'); await expect(keyboard.getByRole('button', { name: '终端 ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await keyboard.getByRole('button', { name: '终端 shift', exact: true }).tap(); await press('终端 Tab', '\x1b[Z');
    await keyboard.getByRole('button', { name: '终端 alt', exact: true }).tap(); await press('终端 ArrowRight', '\x1b[1;3C');
    await keyboard.getByRole('button', { name: '终端 alt', exact: true }).tap(); await press('终端 B', '\x1bb');
    await press('终端 Backspace', '\x7f'); await press('终端 Delete', '\x1b[3~');
    const text = page.getByRole('textbox', { name: '终端文字输入', exact: true });
    const before = input.length; await text.fill('中文输入\n第二行'); expect(input.length).toBe(before);
    await page.getByRole('button', { name: '输入文字到终端', exact: true }).tap();
    await expect.poll(() => input.length).toBe(before + 1); expect(input.at(-1)).toBe('\x1b[200~中文输入\r第二行\x1b[201~'); await expect(text).toHaveValue('');
    await press('终端 Enter', '\r');
    await text.fill('回车提交中文');
    const beforeEnter = input.length; await keyboard.getByRole('button', { name: '终端 Enter', exact: true }).tap();
    await expect.poll(() => input.length).toBe(beforeEnter + 2);
    expect(input.slice(beforeEnter)).toEqual(['\x1b[200~回车提交中文\x1b[201~', '\r']); await expect(text).toHaveValue('');
    await text.fill('保留草稿'); await text.focus(); await press('终端 ArrowLeft', '\x1bOD'); await expect(text).toBeFocused(); await expect(text).toHaveValue('保留草稿');
    await page.getByRole('button', { name: '更多终端按键', exact: true }).tap(); await press('终端 F12', '\x1b[24~'); await press('终端 Home', '\x1bOH');
    await page.getByRole('button', { name: '收起终端键盘', exact: true }).tap(); await expect(keyboard).toBeHidden();
    await page.getByRole('button', { name: '显示终端键盘', exact: true }).tap(); await expect(text).toHaveValue('保留草稿');
    await page.getByRole('button', { name: '复制终端屏幕', exact: true }).tap();
    const screen = page.getByRole('dialog', { name: '复制终端文字', exact: true }); await expect(screen).toBeVisible();
    await expect(screen.getByRole('textbox', { name: '终端屏幕文字', exact: true })).toHaveValue(/Mobile terminal 中文/);
    await screen.getByRole('button', { name: '关闭窗口', exact: true }).tap();
    if (await page.getByRole('button', { name: '更多终端按键', exact: true }).getAttribute('aria-expanded') === 'true') await page.getByRole('button', { name: '更多终端按键', exact: true }).tap();
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 400 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height'))))).toBe(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      const bounds = await keyboard.boundingBox(); expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
      expect((await page.locator('.terminal-view.visible .terminal-container').boundingBox()).height).toBeGreaterThan(25);
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: '.data/mobile-terminal-keyboard.png' });
    for (const socket of wss.clients) socket.close();
    await expect(page.locator('.connection-banner').first()).toBeVisible(); await expect(page.getByRole('button', { name: '输入文字到终端', exact: true })).toBeDisabled();
    await expect(text).toHaveValue('保留草稿'); await expect(page.locator('.connection-banner')).toHaveCount(0);
  } finally { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); }
});
