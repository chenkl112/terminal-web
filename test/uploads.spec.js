import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('real directory drag keeps all batches, nested files and empty directories as one attachment', async ({ page, context }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-folder-'));
  const folder = path.join(temp, '桌面文件夹');
  fs.mkdirSync(path.join(folder, '嵌套目录', '空文件夹'), { recursive: true });
  fs.writeFileSync(path.join(folder, '嵌套目录', '证明.txt'), 'FOLDER_UPLOAD_PROOF_83C1');
  // Chromium's readEntries returns at most 100 entries per batch.
  for (let i = 0; i < 105; i++) fs.writeFileSync(path.join(folder, `文件-${i}.txt`), `content-${i}`);
  fs.writeFileSync(path.join(folder, '空文件.txt'), '');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toBeEnabled();
    const cdp = await context.newCDPSession(page);
    const data = { items: [], files: [folder], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 750, y: 350, data });
    await expect(page.getByTestId('upload-card')).toHaveCount(1);
    await expect(page.getByTestId('upload-card')).toContainText('桌面文件夹');
    await expect(page.getByRole('img', { name: '上传完成', exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('upload-card')).toContainText('107 个文件');
    const draft = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('mono-drafts'))).flatMap(d => d.files).find(f => f.name === '桌面文件夹'));
    expect(draft.kind).toBe('folder');
    expect(draft.files).toBeUndefined();
    expect(fs.readFileSync(path.join(draft.server.path, '嵌套目录', '证明.txt'), 'utf8')).toBe('FOLDER_UPLOAD_PROOF_83C1');
    expect(fs.statSync(path.join(draft.server.path, '嵌套目录', '空文件夹')).isDirectory()).toBeTruthy();
    expect(fs.readdirSync(draft.server.path)).toHaveLength(107);
    expect(fs.statSync(path.join(draft.server.path, '空文件.txt')).size).toBe(0);
    await page.screenshot({ path: '.data/folder-upload-desktop.png' });
    await page.reload();
    await expect(page.getByTestId('upload-card')).toContainText('107 个文件');
    await page.getByRole('button', { name: '移除 桌面文件夹' }).click();

    // A completely empty directory must also complete.
    const empty = path.join(temp, '空目录'); fs.mkdirSync(empty);
    const emptyData = { items: [], files: [empty], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 750, y: 350, data: emptyData });
    await expect(page.getByRole('img', { name: '上传完成', exact: true })).toBeVisible();
    await expect(page.getByTestId('upload-card')).toContainText('0 个文件');
    await page.getByRole('button', { name: '移除 空目录' }).click();
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await expect(page.getByRole('button', { name: '添加文件夹', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '添加文件夹', exact: true }).click();
    await page.getByLabel('选择上传文件夹', { exact: true }).setInputFiles(folder);
    await expect(page.getByRole('img', { name: '上传完成', exact: true })).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: '移除 桌面文件夹' }).click();
    expect(errors).toEqual([]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('multi-chunk file recovers a lost response without duplicating bytes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toBeEnabled();
  let lost = false;
  await page.route('**/api/uploads/*/content?offset=*', async route => {
    if (!lost) { lost = true; await route.fetch(); await route.abort('connectionreset'); }
    else await route.continue();
  });
  const content = Buffer.alloc(40 * 1024 * 1024 + 113, 83);
  await page.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name: '分段恢复.bin', mimeType: 'application/octet-stream', buffer: content });
  await expect(page.getByRole('img', { name: '上传完成', exact: true })).toBeVisible({ timeout: 60000 });
  expect(lost).toBeTruthy();
  const uploaded = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('mono-drafts'))).flatMap(d => d.files).find(f => f.name === '分段恢复.bin').server);
  expect(fs.readFileSync(uploaded.path).equals(content)).toBeTruthy();
  await page.getByRole('button', { name: '移除 分段恢复.bin' }).click();
});

test('new browser retains 8 MiB compatibility when an older server does not advertise streaming chunks', async ({ page }) => {
  await page.route('**/api/uploads/start', async route => {
    const response = await route.fetch(); const data = await response.json(); delete data.chunkSize;
    await route.fulfill({ response, json: data });
  });
  const offsets = [];
  page.on('request', request => { if (request.url().includes('/content?offset=')) offsets.push(Number(new URL(request.url()).searchParams.get('offset'))); });
  await page.goto('/'); await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toBeEnabled();
  const content = Buffer.alloc(9 * 1024 * 1024 + 31, 61);
  await page.getByLabel('选择上传文件', { exact: true }).setInputFiles({ name: '旧服务兼容.bin', mimeType: 'application/octet-stream', buffer: content });
  await expect(page.getByRole('img', { name: '上传完成', exact: true })).toBeVisible({ timeout: 60000 });
  expect(offsets).toEqual([0, 8 * 1024 * 1024]);
  const uploaded = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('mono-drafts'))).flatMap(d => d.files).find(f => f.name === '旧服务兼容.bin').server);
  expect(fs.readFileSync(uploaded.path).equals(content)).toBeTruthy();
});

test('parallel folder upload recovers lost child-completion and folder-entry responses', async ({ page }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-parallel-folder-'));
  const folder = path.join(directory, '并行恢复'); fs.mkdirSync(path.join(folder, 'nested', 'empty'), { recursive: true });
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(folder, i % 2 ? 'nested' : '', `${i}.bin`), Buffer.alloc(32768 + i, i));
  let lostChild = false, lostEntry = false;
  await page.route('**/api/uploads/*/complete', async route => {
    const response = await route.fetch(), body = await response.json();
    if (!body.kind && !lostChild) { lostChild = true; await route.abort('connectionreset'); }
    else await route.fulfill({ response });
  });
  await page.route('**/api/uploads/*/entries', async route => {
    const data = route.request().postDataJSON();
    if (!data.directory && !lostEntry) { lostEntry = true; await route.fetch(); await route.abort('connectionreset'); }
    else await route.continue();
  });
  try {
    await page.goto('/'); await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toBeEnabled();
    await page.getByLabel('选择上传文件夹', { exact: true }).setInputFiles(folder);
    await expect(page.getByRole('img', { name: '上传完成', exact: true })).toBeVisible({ timeout: 60000 });
    expect(lostChild && lostEntry).toBeTruthy();
    const uploaded = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('mono-drafts'))).flatMap(d => d.files).find(f => f.name === '并行恢复').server);
    expect(uploaded.fileCount).toBe(8);
    for (let i = 0; i < 8; i++) expect(fs.readFileSync(path.join(uploaded.path, i % 2 ? 'nested' : '', `${i}.bin`)).equals(Buffer.alloc(32768 + i, i))).toBeTruthy();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
