import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

async function dragFile(page, name, content, type = 'text/plain') {
  await page.evaluate(({ name, content, type }) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([content], name, { type }));
    const main = document.querySelector('main');
    for (const kind of ['dragenter', 'dragover', 'drop']) main.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name, content, type });
}

test('desktop chat, real terminal, drag upload with circular progress, and live Codex usage', async ({ page, context, request }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const initial = await (await request.get('/api/state')).json();
  for (const t of initial.terminals) await request.delete(`/api/terminals/${t.id}`);
  for (const c of initial.conversations) if (c.activeTurnId) await request.post(`/api/conversations/${c.id}/interrupt`, { data: {} });
  if (initial.conversations.some(c => c.turns.length)) await request.post('/api/conversations', { data: {} });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天想做点什么？' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeEnabled();
  await expect(page.getByTestId('total-tokens')).toHaveText('—');
  await page.screenshot({ path: '.data/desktop-ready.png', animations: 'disabled' });

  await page.getByRole('button', { name: '添加工作区' }).click();
  await page.getByRole('button', { name: /新建终端/ }).click();
  await expect(page.locator('.terminal-view.visible .xterm')).toBeVisible();
  await page.locator('.terminal-view.visible .xterm-helper-textarea').focus();
  await page.keyboard.type("printf '\\x4dONO_TERMINAL_OK\\n'");
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await (await request.get('/api/state')).json()).terminals.some(t => t.replay.includes('MONO_TERMINAL_OK\r\n'))).toBeTruthy();
  await page.reload();
  await page.getByRole('tab', { name: '终端', exact: true }).nth(1).click();
  await expect(page.locator('.terminal-view.visible .xterm')).toBeVisible();
  const before = (await (await request.get('/api/state')).json()).terminals.find(t => !t.isDefault);
  expect(before.replay).toContain('MONO_TERMINAL_OK');
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: 3000000, uploadThroughput: 24000, latency: 80 });
  await dragFile(page, '进度测试.txt', 'z'.repeat(320 * 1024));
  const ring = page.getByRole('progressbar', { name: '上传进度', exact: true });
  await expect(ring).toBeVisible();
  await expect.poll(async () => Number(await ring.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  expect(Number(await ring.getAttribute('aria-valuenow'))).toBeLessThan(100);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.screenshot({ path: '.data/upload-progress.png', animations: 'disabled' });
  await expect(page.getByRole('img', { name: '上传完成', exact: true })).toBeVisible({ timeout: 45000 });
  await page.getByRole('button', { name: '移除 进度测试.txt' }).click();
  await cdp.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 });

  const marker = 'LOCAL_FILE_PROOF_71A9';
  await dragFile(page, '附件验证.txt', `验证口令：${marker}\n`);
  await expect(page.getByRole('img', { name: '上传完成', exact: true })).toBeVisible();
  await expect(page.getByTestId('upload-card')).toContainText('附件验证.txt');
  await expect(page.getByTestId('upload-card')).toContainText('已传到本机');
  const uploads = JSON.parse(fs.readFileSync(path.join(process.env.TEST_DATA_DIR || '.data/qa', 'state.json'), 'utf8')).uploads;
  const uploaded = Object.values(uploads).filter(f => f.name === '附件验证.txt').sort((a, b) => b.uploadedAt - a.uploadedAt)[0];
  expect(fs.readFileSync(uploaded.path, 'utf8')).toContain(marker);

  if (process.env.LIVE_CODEX === '1') {
    await page.getByRole('textbox', { name: '发送给 Codex' }).fill('请读取附件验证.txt，只回复文件中的验证口令，不要作其他修改。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => {
      const approval = page.locator('.approval');
      if (await approval.isVisible()) {
        // This test may approve only the read of the file it just uploaded.
        expect(await approval.locator('pre').innerText()).toContain(uploaded.path);
        await approval.getByRole('button', { name: '允许本次' }).click();
      }
      return await page.locator('.agent-message').filter({ hasText: marker }).isVisible();
    }, { timeout: 120000 }).toBeTruthy();
    await expect(page.locator('.sent-file')).toContainText('附件验证.txt');
    await expect(page.locator('.user-bubble')).toContainText('请读取附件验证.txt');
    await expect(page.getByTestId('total-tokens')).not.toHaveText('—', { timeout: 30000 });
    await expect(page.getByTestId('context-percent')).not.toHaveText('等待数据');
    await page.getByRole('button', { name: '查看 token 和上下文用量' }).click();
    await expect(page.locator('.usage-popover')).toContainText('缓存输入');
    await page.screenshot({ path: '.data/chat-usage.png', animations: 'disabled' });
    console.log('真实 Codex 用量：', await page.locator('.usage-popover').innerText());
    await page.locator('.popover-dismiss').click({ position: { x: 5, y: 5 } });
    await page.reload();
    await expect(page.locator('.agent-message').filter({ hasText: marker })).toBeVisible();
    await expect(page.locator('.sent-file')).toContainText('附件验证.txt');
    await expect(page.getByTestId('total-tokens')).not.toHaveText('—');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.getByRole('button', { name: '收起侧栏' }).isVisible()) await page.getByRole('button', { name: '收起侧栏' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看 token 和上下文用量' })).toBeVisible();
  await page.screenshot({ path: '.data/mobile.png', animations: 'disabled' });
  expect(errors).toEqual([]);
  const terminals = (await (await request.get('/api/state')).json()).terminals;
  for (const t of terminals) await request.delete(`/api/terminals/${t.id}`);
});
