import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadRouter } from '../server/uploads.js';

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-terminal-files-')), uploadDir = path.join(root, 'uploads'); fs.mkdirSync(uploadDir);
  const uploads = {}, input = [];
  const terminal = { id: 'shared', title: '终端', workspaceId: 'project', isDefault: true, cols: 100, rows: 30, replay: 'Terminal upload ready\r\n\x1b[?2004h' };
  const state = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', name: 'Project', path: root }], defaultWorkspaceId: 'project', conversations: [{ id: 'chat', workspaceId: 'project', threadId: 'native', title: '聊天', status: 'idle', turns: [], attachments: {} }], terminals: [terminal], approvals: [] };
  const app = express(); app.use(express.json()); app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.use('/api/uploads', uploadRouter({ uploadDir, uploads, save() {} }));
  app.use(express.static(process.env.TERMINAL_UPLOAD_TEST_DIST || 'dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => { socket.send(JSON.stringify(state)); socket.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'terminal/input') input.push(message); }); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { root, uploads, input, terminal, origin: `http://127.0.0.1:${server.address().port}`, close() { wss.close(); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('terminal uploads files, folders and pasted screenshots to disk and inserts paths without submitting', async ({ page, context }) => {
  const app = await harness(); let release;
  const held = new Promise(resolve => { release = resolve; }); let first = true;
  await page.route('**/api/uploads/start', async route => { if (first) { first = false; await held; } await route.continue(); });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(app.origin);
    const tab = page.getByRole('tab', { name: '终端', exact: true }); await tab.click(); await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('group', { name: '终端输入键盘', exact: true })).toBeHidden();
    await page.getByRole('button', { name: '终端上传附件', exact: true }).click();
    await expect(page.getByRole('menu', { name: '终端上传', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: '添加文件', exact: true }).click();
    const name = "资料 '$(printf X).txt", content = Buffer.from('TERMINAL_UPLOAD_PROOF_中文');
    await page.getByLabel('选择终端上传文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: content });
    const card = page.getByTestId('upload-card').filter({ hasText: name });
    await expect(card.getByRole('progressbar', { name: '上传进度', exact: true })).toBeVisible();
    await expect(card.locator('.upload-speed')).toContainText(/测速中|\/s/); expect(app.input).toHaveLength(0); release();
    await expect(card.getByRole('img', { name: '上传完成', exact: true })).toBeVisible();
    const file = Object.values(app.uploads).find(file => file.name === name); expect(fs.readFileSync(file.path).equals(content)).toBeTruthy();
    expect(app.input).toHaveLength(0); await card.getByRole('button', { name: '插入路径', exact: true }).click();
    await expect.poll(() => app.input.length).toBe(1); expect(app.input[0].data.startsWith('\x1b[200~')).toBeTruthy();
    expect(app.input[0].data).not.toMatch(/[\r\n]/); expect(app.input[0].data).toContain("'\"'\"'");

    const folder = path.join(app.root, '文件夹'); fs.mkdirSync(path.join(folder, 'nested', 'empty'), { recursive: true }); fs.writeFileSync(path.join(folder, 'nested', 'proof.txt'), 'folder proof');
    const cdp = await context.newCDPSession(page), drag = { items: [], files: [folder], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 700, y: 250, data: drag });
    const folderCard = page.getByTestId('upload-card').filter({ hasText: '文件夹' }); await expect(folderCard.getByRole('img', { name: '上传完成', exact: true })).toBeVisible();
    await expect(tab).toHaveAttribute('aria-selected', 'true'); expect(app.input).toHaveLength(1);
    const uploadedFolder = Object.values(app.uploads).find(file => file.kind === 'folder');
    expect(fs.readFileSync(path.join(uploadedFolder.path, 'nested', 'proof.txt'), 'utf8')).toBe('folder proof'); expect(fs.statSync(path.join(uploadedFolder.path, 'nested', 'empty')).isDirectory()).toBeTruthy();

    await page.locator('.terminal-view.visible').evaluate(element => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF2kAAAAASUVORK5CYII='), char => char.charCodeAt(0));
      const clipboardData = new DataTransfer(); clipboardData.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
    const screenshot = page.getByTestId('upload-card').filter({ hasText: 'screenshot.png' }); await expect(screenshot.getByRole('img', { name: '上传完成', exact: true })).toBeVisible(); expect(app.input).toHaveLength(1);
    const large = Buffer.alloc(40 * 1024 * 1024 + 113, 83);
    await page.getByLabel('选择终端上传文件', { exact: true }).setInputFiles({ name: 'large.bin', mimeType: 'application/octet-stream', buffer: large });
    const largeCard = page.getByTestId('upload-card').filter({ hasText: 'large.bin' }); await expect(largeCard.getByRole('img', { name: '上传完成', exact: true })).toBeVisible({ timeout: 60000 });
    expect(fs.readFileSync(Object.values(app.uploads).find(file => file.name === 'large.bin').path).equals(large)).toBeTruthy();
    await page.getByRole('button', { name: '插入全部路径', exact: true }).click(); await expect.poll(() => app.input.length).toBe(2);
    expect(app.input[1].data).toContain(uploadedFolder.path); expect(app.input[1].data).not.toMatch(/[\r\n]/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mono-drafts'))); expect(saved.chat?.files || []).toHaveLength(0); expect(saved['terminal:workspace:project'].files).toHaveLength(4);
    app.terminal.id = 'shared-after-service-restart'; await page.reload(); await expect(page.getByTestId('upload-card')).toHaveCount(4); await expect(tab).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: '.data/terminal-files-desktop.png' });
    await page.getByRole('button', { name: `移除 ${name}`, exact: true }).click(); await expect(page.getByTestId('upload-card')).toHaveCount(3); expect(fs.existsSync(file.path)).toBeTruthy();
    await page.getByRole('tab', { name: 'Codex', exact: true }).click();
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 700, y: 250, data: drag });
    await expect(page.locator('.chat-panel.visible').getByRole('img', { name: '上传完成', exact: true })).toBeVisible();
    const afterChatUpload = await page.evaluate(() => JSON.parse(localStorage.getItem('mono-drafts')));
    expect(afterChatUpload.chat.files).toHaveLength(1); expect(afterChatUpload['terminal:workspace:project'].files).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally { release(); await page.goto('about:blank'); app.close(); }
});

test('phone terminal offers file and camera uploads while retaining a collapsed keyboard and usable compact layout', async ({ browser }) => {
  const app = await harness(), context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } }), page = await context.newPage();
  try {
    await page.goto(app.origin); await page.getByRole('tab', { name: '终端', exact: true }).tap(); await page.getByRole('button', { name: '终端上传附件', exact: true }).tap();
    await expect(page.getByRole('menuitem', { name: '拍照上传', exact: true })).toBeVisible();
    await expect(page.getByLabel('终端拍照上传', { exact: true })).toHaveAttribute('capture', 'environment');
    await page.getByRole('menuitem', { name: '添加文件', exact: true }).tap();
    await page.getByLabel('选择终端上传文件', { exact: true }).setInputFiles({ name: '手机文件.txt', mimeType: 'text/plain', buffer: Buffer.from('phone file') });
    const card = page.getByTestId('upload-card'); await expect(card.getByRole('img', { name: '上传完成', exact: true })).toBeVisible();
    const keyboard = page.getByRole('group', { name: '终端输入键盘', exact: true }); await expect(keyboard).toBeHidden(); expect(app.input).toHaveLength(0);
    await card.getByRole('button', { name: '插入路径', exact: true }).tap(); await expect.poll(() => app.input.length).toBe(1); expect(app.input[0].data).not.toMatch(/[\r\n]/);
    await page.getByRole('button', { name: '显示终端键盘', exact: true }).tap(); await expect(keyboard).toBeVisible(); await expect(page.getByRole('button', { name: '展开终端附件', exact: true })).toBeVisible();
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 400 }]) {
      await page.setViewportSize(viewport); await expect.poll(() => page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height'))))).toBe(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy(); const bounds = await keyboard.boundingBox(); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
      expect((await page.locator('.terminal-view.visible .terminal-container').boundingBox()).height).toBeGreaterThan(25);
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '收起终端键盘', exact: true }).tap();
    await page.getByRole('button', { name: '展开终端附件', exact: true }).tap(); await page.screenshot({ path: '.data/terminal-files-mobile.png' });
  } finally { await context.close(); app.close(); }
});
