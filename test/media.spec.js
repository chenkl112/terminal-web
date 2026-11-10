import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mediaRouter } from '../server/media.js';

test('generated images load from saved paths, open previews, download originals and survive refresh', async ({ page }) => {
  const base64 = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 120; const context = canvas.getContext('2d'); context.fillStyle = '#777'; context.fillRect(0, 0, 80, 120); return canvas.toDataURL('image/png').split(',')[1]; });
  const bytes = Buffer.from(base64, 'base64'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-image-ui-'));
  const image = path.join(dir, '生成照片.png'), missing = path.join(dir, '稍后生成.png'); fs.writeFileSync(image, bytes);
  const report = path.join(dir, '导出结果_含100%标准线.txt'), reportText = 'Codex 生成的文件，可以保存到访问网页的设备。'; fs.writeFileSync(report, reportText);
  const conversation = { id: 'images', threadId: 'native', title: '图片测试', cwd: dir, workspaceId: 'project', status: 'idle', attachments: {}, turns: [{ id: 'turn', status: 'completed', items: [
    { type: 'imageView', id: 'inspection', path: image },
    { type: 'imageGeneration', id: 'native-image', status: 'completed', result: base64 },
    { type: 'agentMessage', id: 'reply', phase: 'final_answer', text: `![生成照片](${image})\n\n[下载原图](${image})\n\n<img src="javascript:alert(1)" onerror="window.__imageInjected=1"><img alt="文件协议照片" src="${pathToFileURL(image).href}" onerror="window.__imageInjected=1">\n\n![稍后生成](${missing})\n\n[下载结果](<${report}>) [再下载一次](<${report}>)` },
  ] }] };
  const state = { type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', path: dir, name: 'Project' }], defaultWorkspaceId: 'project', conversations: [conversation], terminals: [], approvals: [] };
  const app = express(); app.get('/api/auth', (req, res) => res.json({ authenticated: true })); app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/conversations', mediaRouter({ state })); app.use(express.static(process.env.MEDIA_TEST_DIST || 'dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' }); wss.on('connection', socket => socket.send(JSON.stringify(state)));
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const imageButton = page.getByRole('button', { name: '查看大图：生成照片', exact: true });
    await imageButton.scrollIntoViewIfNeeded(); await expect(imageButton.locator('img')).toBeVisible();
    await expect.poll(() => imageButton.locator('img').evaluate(img => img.naturalWidth)).toBe(80);
    const fileImage = page.getByRole('button', { name: '查看大图：文件协议照片', exact: true });
    await expect.poll(() => fileImage.locator('img').evaluate(img => img.naturalHeight)).toBe(120);
    await expect.poll(() => page.locator('.generated-image-card img').evaluate(img => img.naturalWidth)).toBe(80);
    expect(await page.evaluate(() => window.__imageInjected)).toBeUndefined(); await expect(page.locator('.markdown img[onerror]')).toHaveCount(0);
    await imageButton.click(); const viewer = page.getByRole('dialog', { name: '生成照片', exact: true });
    await expect(viewer).toBeVisible(); await expect.poll(() => viewer.locator('img').evaluate(img => img.naturalWidth)).toBe(80); await page.keyboard.press('Escape');
    const downloading = page.waitForEvent('download'); await page.locator('.markdown').getByRole('link', { name: '下载原图', exact: true }).click();
    const download = await downloading; expect(fs.readFileSync(await download.path()).equals(bytes)).toBeTruthy();
    const fileCard = page.getByRole('list', { name: '可下载文件', exact: true }); await expect(fileCard.getByRole('listitem')).toHaveCount(1);
    await expect(fileCard).toContainText('导出结果_含100%标准线.txt'); await expect(fileCard).toContainText(report);
    const reportDownload = page.waitForEvent('download'); await fileCard.getByRole('link', { name: '下载文件：导出结果_含100%标准线.txt', exact: true }).click();
    const saved = await reportDownload; expect(saved.suggestedFilename()).toBe('导出结果_含100%标准线.txt'); expect(fs.readFileSync(await saved.path(), 'utf8')).toBe(reportText);
    let rejectedDownloads = 0;
    const observeDownload = () => { rejectedDownloads++; }; page.on('download', observeDownload);
    await page.route('**/files?**', async route => {
      if (route.request().method() === 'HEAD') await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' });
      else await route.continue();
    });
    await fileCard.getByRole('link', { name: '下载文件：导出结果_含100%标准线.txt', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '下载失败：' })).toContainText('下载失败：无法读取此文件');
    expect(rejectedDownloads).toBe(0); page.off('download', observeDownload); await page.unroute('**/files?**');
    const retry = page.getByRole('button', { name: '查看大图：稍后生成', exact: true }); await retry.scrollIntoViewIfNeeded(); await expect(retry).toContainText('点击重试');
    fs.writeFileSync(missing, bytes); await retry.click(); await expect.poll(() => retry.locator('img').evaluate(img => img.naturalWidth)).toBe(80);
    await page.reload(); await imageButton.scrollIntoViewIfNeeded(); await expect.poll(() => imageButton.locator('img').evaluate(img => img.naturalWidth)).toBe(80);
    await page.setViewportSize({ width: 390, height: 844 }); if (await page.getByRole('button', { name: '收起侧栏' }).isVisible()) await page.getByRole('button', { name: '收起侧栏' }).click();
    const fileBounds = await fileCard.boundingBox(); expect(fileBounds.x).toBeGreaterThanOrEqual(0); expect(fileBounds.x + fileBounds.width).toBeLessThanOrEqual(390);
    await imageButton.click(); await expect(viewer).toBeVisible(); const bounds = await viewer.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: '.data/generated-image-mobile.png' });
  } finally { await page.goto('about:blank'); wss.close(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
