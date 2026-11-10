import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('model, reasoning and permissions persist and reach native Codex execution', async ({ page, request }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeEnabled();
  const { models } = await (await request.get('/api/models')).json();
  const selected = models.find(m => m.model === 'gpt-6-luna') || models.find(m => !m.supportedReasoningEfforts.some(e => e.reasoningEffort === 'ultra'));
  expect(selected).toBeTruthy();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await expect(page.getByRole('menu', { name: '选择模型', exact: true })).toBeVisible();
  await page.screenshot({ path: '.data/model-menu.png', animations: 'disabled' });
  await page.getByRole('menuitemradio').filter({ hasText: selected.displayName }).click();
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(selected.displayName);

  await page.getByRole('button', { name: '选择思考深度', exact: true }).click();
  await expect(page.getByRole('menuitemradio').filter({ hasText: 'Ultra' })).toHaveCount(0);
  await page.getByRole('menuitemradio').filter({ hasText: '兼顾速度与推理深度' }).click();
  await expect(page.getByRole('button', { name: '选择思考深度', exact: true })).toHaveText('中');
  for (const label of ['只读', '默认权限', '完全访问']) {
    await page.getByRole('button', { name: '选择权限', exact: true }).click();
    if (label === '完全访问') await page.screenshot({ path: '.data/permission-menu.png', animations: 'disabled' });
    await page.getByRole('menuitemradio').filter({ has: page.locator('strong', { hasText: label }) }).click();
    await expect(page.getByRole('button', { name: '选择权限', exact: true })).toHaveText(label);
  }
  await page.reload();
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(selected.displayName);
  await expect(page.getByRole('button', { name: '选择思考深度', exact: true })).toHaveText('中');
  await expect(page.getByRole('button', { name: '选择权限', exact: true })).toHaveText('完全访问');
  let state = await (await request.get('/api/state')).json();
  const current = state.conversations[0];
  const rejected = await request.patch(`/api/conversations/${current.id}/settings`, { data: { effort: 'ultra' } });
  expect(rejected.status()).toBe(400);

  if (process.env.LIVE_CODEX === '1') {
    const marker = 'SETTINGS_NATIVE_PROOF_39B7';
    await page.getByRole('textbox', { name: '发送给 Codex' }).fill(`只回复 ${marker}。`);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeDisabled();
    await expect(page.locator('.agent-message').filter({ hasText: marker })).toBeVisible({ timeout: 120000 });
    await expect(page.locator('.approval')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeEnabled();
    state = await (await request.get('/api/state')).json();
    const c = state.conversations.find(c => c.id === current.id);
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const sessions = path.join(home, 'sessions');
    const relative = fs.readdirSync(sessions, { recursive: true }).find(name => name.includes(c.threadId) && name.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(sessions, relative), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const native = records.filter(r => r.type === 'turn_context').at(-1).payload;
    expect(native.model).toBe(selected.model);
    expect(native.effort).toBe('medium');
    expect(native.approval_policy).toBe('never');
    expect(native.sandbox_policy.type).toBe('danger-full-access');
    console.log('Native Codex confirmed:', { model: native.model, effort: native.effort, permission: native.sandbox_policy.type, approval: native.approval_policy });
  }
  const beforeDraft = (await (await request.get('/api/state')).json()).conversations.length;
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  expect((await (await request.get('/api/state')).json()).conversations.length).toBe(beforeDraft);
  await expect(page.locator('.header-title')).toHaveText('新建任务');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mono-active-chat'))).toBe(current.id);
  await expect(page.getByRole('heading', { name: '从一个想法开始' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(selected.displayName);
  await expect(page.getByRole('button', { name: '选择思考深度', exact: true })).toHaveText('中');
  await expect(page.getByRole('button', { name: '选择权限', exact: true })).toHaveText('完全访问');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.getByRole('button', { name: '收起侧栏' }).isVisible()) await page.getByRole('button', { name: '收起侧栏' }).click();
  for (const label of ['选择模型', '选择思考深度', '选择权限']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const bounds = await page.getByRole('menu').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '.data/settings-mobile.png', animations: 'disabled' });
  expect(errors).toEqual([]);
});
