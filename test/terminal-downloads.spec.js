import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { terminalDownloadsRouter } from '../server/terminalDownloads.js';

async function harness({ assets = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-terminal-download-ui-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-terminal-external-ui-'));
  const outsideFile = path.join(outside, 'outside.txt'); fs.writeFileSync(outsideFile, 'outside workspace file');
  const report = path.join(root, '报告_含100%标准线 中文.txt'), reportText = '无需切换网页对话，直接下载到当前设备。';
  const source = path.join(root, 'source.js'), osc = path.join(root, '链接结果.txt');
  fs.writeFileSync(report, reportText); fs.writeFileSync(source, 'source contents'); fs.writeFileSync(osc, 'OSC8 contents');
  const terminal = { id: 'shared', cwd: root, title: '终端', workspaceId: 'project', isDefault: true, cols: 100, rows: 30,
    replay: `已生成：'${report}'\r\n源码 ./source.js:12\r\n2.33M v0.163.0 150.3MB/s\r\n目录 '${root}'\r\n已删除 ./gone.zip\r\n\x1b]8;;${pathToFileURL(osc).href}\x1b\\打开生成结果\x1b]8;;\x1b\\\r\n` };
  const assetName = 'shaoshao-gazebo-lidar-demo-source-20261029.zip', assetContent = Buffer.from('PK\x03\x04terminal asset ZIP');
  const assetDir = path.join(root, 'published-assets');
  if (assets) {
    fs.mkdirSync(assetDir); fs.writeFileSync(path.join(assetDir, assetName), assetContent);
    fs.writeFileSync(path.join(assetDir, '演示报告_100%中文.html'), '<html>Generated report</html>');
    terminal.replay += `/assets/${assetName}\r\n/assets/missing.zip\r\n`;
  }
  const snapshot = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', name: 'Project', path: root }], defaultWorkspaceId: 'project', conversations: [], terminals: [terminal], approvals: [] };
  const input = [], infoRequests = [];
  const app = express(); app.use(express.json()); app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.use('/api/terminals', (req, res, next) => { if (req.query.info === '1') infoRequests.push(req.query.path); next(); });
  app.use('/api/terminals', terminalDownloadsRouter({ terminals: new Map([[terminal.id, terminal]]), uploadDir: path.join(root, 'uploads') }));
  if (assets) app.use('/assets', express.static(assetDir));
  app.use(express.static('dist'));
  if (assets) app.get('/{*path}', (_, res) => res.sendFile(path.resolve('dist/index.html')));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => { socket.send(JSON.stringify(snapshot)); socket.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'terminal/input') input.push(message.data); }); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { root, outsideFile, report, reportText, terminal, input, infoRequests, assetName, assetContent, origin: `http://127.0.0.1:${server.address().port}`,
    close() { wss.close(); server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); } };
}

test('terminal downloads web assets directly, accepts pasted site URLs and rejects SPA fallback files', async ({ page }) => {
  const app = await harness({ assets: true });
  try {
    await page.goto(app.origin); await page.getByRole('tab', { name: '终端', exact: true }).click();
    await page.getByRole('button', { name: '终端下载文件', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '终端下载', exact: true });
    const list = dialog.getByRole('list', { name: '终端文件', exact: true });
    await expect(list).toContainText(app.assetName); await expect(list).not.toContainText('missing.zip');
    const downloadEvent = page.waitForEvent('download'); await dialog.getByRole('button', { name: `下载文件：${app.assetName}`, exact: true }).click();
    const saved = await downloadEvent; expect(saved.suggestedFilename()).toBe(app.assetName); expect(fs.readFileSync(await saved.path()).equals(app.assetContent)).toBeTruthy();
    const field = dialog.getByRole('textbox', { name: '文件路径', exact: true });
    await field.fill(`${app.origin}/assets/${app.assetName}`);
    const fullUrlEvent = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载', exact: true }).click();
    expect(fs.readFileSync(await (await fullUrlEvent).path()).equals(app.assetContent)).toBeTruthy();
    await field.fill('/assets/演示报告_100%中文.html');
    const htmlEvent = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载', exact: true }).click();
    const html = await htmlEvent; expect(html.suggestedFilename()).toBe('演示报告_100%中文.html'); expect(fs.readFileSync(await html.path(), 'utf8')).toBe('<html>Generated report</html>');
    for (const name of ['missing.zip', 'missing.html']) {
      await field.fill('/assets/' + name); await dialog.getByRole('button', { name: '下载', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('文件不存在');
    }
    // The browser handles asset URLs; the filesystem endpoint never sees /assets/.
    expect(app.infoRequests.filter(value => value.startsWith('/assets/'))).toEqual([]); expect(app.input).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); app.close(); }
});

test('terminal downloads recent and manually entered paths, displays errors and preserves the CLI session', async ({ page }) => {
  const app = await harness();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(app.origin); await page.getByRole('tab', { name: '终端', exact: true }).click();
    const trigger = page.getByRole('button', { name: '终端下载文件', exact: true }); await expect(trigger).toBeEnabled(); await trigger.click();
    const dialog = page.getByRole('dialog', { name: '终端下载', exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('list', { name: '终端文件', exact: true })).toContainText('报告_含100%标准线 中文.txt');
    await expect(dialog).toContainText('链接结果.txt');
    const list = dialog.getByRole('list', { name: '终端文件', exact: true });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    for (const excluded of ['2.33M', 'v0.163.0', '150.3MB/s', 'gone.zip']) await expect(list).not.toContainText(excluded);
    const downloadEvent = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载文件：报告_含100%标准线 中文.txt', exact: true }).click();
    const download = await downloadEvent; expect(download.suggestedFilename()).toBe('报告_含100%标准线 中文.txt'); expect(fs.readFileSync(await download.path(), 'utf8')).toBe(app.reportText);
    await expect(dialog.getByRole('status')).toContainText('已开始下载');
    const field = dialog.getByRole('textbox', { name: '文件路径', exact: true });
    await field.fill('./source.js:12:3'); const sourceEvent = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载', exact: true }).click();
    const source = await sourceEvent; expect(source.suggestedFilename()).toBe('source.js'); expect(fs.readFileSync(await source.path(), 'utf8')).toBe('source contents');
    await field.fill('./missing.txt'); await dialog.getByRole('button', { name: '下载', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('文件不存在');
    await field.fill(app.root); await dialog.getByRole('button', { name: '下载', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('打包为 ZIP');
    await field.fill(app.outsideFile); const outsideEvent = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载', exact: true }).click();
    const outsideDownload = await outsideEvent; expect(fs.readFileSync(await outsideDownload.path(), 'utf8')).toBe('outside workspace file');
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    // xterm's file link opens the download dialog without writing commands to the PTY.
    const row = page.locator('.terminal-view.visible .xterm-rows>div').filter({ hasText: '源码' }).first();
    const pathLink = row.locator('span').filter({ hasText: './source.js:12' }).last();
    await expect(pathLink).toBeVisible();
    const bounds = await pathLink.boundingBox(); const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await expect(page.locator('.terminal-view.visible .xterm-cursor-pointer')).toHaveCount(1);
    await page.mouse.click(x, y);
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('textbox', { name: '文件路径', exact: true })).toHaveValue('./source.js');
    await page.keyboard.press('Escape');
    expect(app.input).toEqual([]); expect(errors).toEqual([]);
  } finally { await page.goto('about:blank').catch(() => {}); app.close(); }
});

test('unloaded terminal download service shows a restart explanation and retries without fake file entries', async ({ page }) => {
  const app = await harness();
  await page.route('**/api/terminals/shared/files/check', route => route.fulfill({ status: 404, json: { error: '接口不存在' } }));
  try {
    await page.goto(app.origin); await page.getByRole('tab', { name: '终端', exact: true }).click();
    await page.getByRole('button', { name: '终端下载文件', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '终端下载', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('需要重启后端服务');
    await expect(dialog.getByRole('listitem')).toHaveCount(0);
    await dialog.getByRole('textbox', { name: '文件路径', exact: true }).fill(app.report);
    await expect(dialog.getByRole('button', { name: '下载', exact: true })).toBeDisabled();
    await page.unroute('**/api/terminals/shared/files/check'); await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
    await expect(dialog.getByRole('listitem')).toHaveCount(3); await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '下载', exact: true })).toBeEnabled();
  } finally { await page.goto('about:blank').catch(() => {}); app.close(); }
});

test('phone terminal downloads without switching tabs or expanding the keyboard', async ({ browser }) => {
  const app = await harness(), context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(app.origin); const tab = page.getByRole('tab', { name: '终端', exact: true }); await tab.tap();
    await page.getByRole('button', { name: '终端下载文件', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: '终端下载', exact: true }); await expect(dialog).toBeVisible();
    const downloadEvent = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载文件：报告_含100%标准线 中文.txt', exact: true }).tap();
    const downloaded = await downloadEvent; expect(fs.readFileSync(await downloaded.path(), 'utf8')).toBe(app.reportText);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 640 });
      const bounds = await dialog.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
    await dialog.getByRole('button', { name: '关闭窗口', exact: true }).tap();
    await expect(tab).toHaveAttribute('aria-selected', 'true'); await expect(page.getByRole('group', { name: '终端输入键盘', exact: true })).toBeHidden();
    expect(app.input).toEqual([]);
  } finally { await context.close(); app.close(); }
});
