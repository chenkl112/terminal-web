import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function renameCurrent(page, title) {
  await page.getByRole('button', { name: '对话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名对话' });
  await dialog.getByRole('textbox', { name: '对话名称' }).fill(title);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).not.toBeVisible();
}
async function chooseWorkspace(page, name) {
  await page.getByRole('button', { name: '选择工作区', exact: true }).click();
  await page.getByRole('menuitem').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click();
}

test('workspace switching, real terminal cwd, pinned conversations, archive/restore and refresh', async ({ page, request, context }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-workspace-'));
  const project = path.join(directory, '项目 A'); fs.mkdirSync(project);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const initial = await (await request.get('/api/state')).json();
  const original = initial.workspaces.find(w => w.id === initial.defaultWorkspaceId);
  let terminal;
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Codex', exact: true }).click();
    await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeEnabled();
    await renameCurrent(page, '原工作区对话');
    const originalChat = await page.evaluate(() => localStorage.getItem('mono-active-chat'));
    await page.getByRole('textbox', { name: '发送给 Codex' }).fill('留在原工作区的草稿');
    await page.getByRole('button', { name: '打开工作区文件夹' }).click();
    const picker = page.getByRole('dialog', { name: '打开工作区' });
    await picker.getByRole('textbox', { name: '工作区文件夹路径' }).fill(project);
    await picker.getByRole('button', { name: '前往文件夹' }).click();
    await expect(picker.getByText('此文件夹内没有子文件夹')).toBeVisible();
    await picker.getByRole('button', { name: '选择此文件夹' }).click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toHaveText('项目 A');
    await expect(page.locator(`[data-conversation-id="${originalChat}"]`)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toHaveValue('');
    let state = await (await request.get('/api/state')).json();
    const workspaceB = state.workspaces.find(w => w.name === '项目 A');
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    await expect(page.locator('.header-title')).toHaveText('新建任务');
    expect((await (await request.get('/api/state')).json()).conversations.length).toBe(state.conversations.length);
    const seeded = await (await request.post('/api/conversations', { data: { workspaceId: workspaceB.id } })).json();
    await expect(page.locator(`[data-conversation-id="${seeded.id}"]`)).toBeVisible();
    await page.locator(`[data-conversation-id="${seeded.id}"] .conversation-link`).click();
    await renameCurrent(page, '需要固定的对话');
    const pinnedId = await page.evaluate(() => localStorage.getItem('mono-active-chat'));
    state = await (await request.get('/api/state')).json();
    const a = state.conversations.find(c => c.id === pinnedId);
    expect(a.cwd).toBe(project);
    expect(a.workspaceId).not.toBe(original.id);
    const beforeBlankDraft = state.conversations.length;
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    await expect(page.locator('.header-title')).toHaveText('新建任务');
    expect((await (await request.get('/api/state')).json()).conversations.length).toBe(beforeBlankDraft);
    const secondFixture = await (await request.post('/api/conversations', { data: { workspaceId: workspaceB.id } })).json();
    await expect(page.locator(`[data-conversation-id="${secondFixture.id}"]`)).toBeVisible();
    await page.locator(`[data-conversation-id="${secondFixture.id}"] .conversation-link`).click();
    await renameCurrent(page, '另一条对话');
    const row = page.locator(`[data-conversation-id="${pinnedId}"]`);
    await row.getByRole('button', { name: '对话操作：需要固定的对话', exact: true }).click();
    await page.getByRole('menuitem', { name: '固定对话', exact: true }).click();
    await expect(page.locator('.conversation-section-heading').filter({ hasText: '已固定' })).toBeVisible();
    await expect(page.locator('.conversation-row').first()).toHaveAttribute('data-conversation-id', pinnedId);
    await row.getByRole('button', { name: '需要固定的对话', exact: true }).click();

    const other = await context.newPage();
    await other.goto('/');
    await expect(other.locator(`[data-conversation-id="${pinnedId}"]`)).toBeVisible();
    await row.getByRole('button', { name: '对话操作：需要固定的对话', exact: true }).click();
    await page.getByRole('menuitem', { name: '归档对话', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(other.locator(`[data-conversation-id="${pinnedId}"]`)).toHaveCount(0);
    await expect(page.locator('.archived-banner')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toBeDisabled();
    expect((await request.post(`/api/conversations/${pinnedId}/messages`, { data: { text: 'must not send' } })).status()).toBe(409);
    expect((await request.patch(`/api/conversations/${pinnedId}`, { data: { pinned: true } })).status()).toBe(409);
    await page.reload();
    await page.getByRole('tab', { name: 'Codex', exact: true }).click();
    await expect(page.locator('.archived-banner')).toBeVisible();
    await page.getByRole('button', { name: '查看已归档对话' }).click();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '对话操作：需要固定的对话', exact: true }).click();
    await page.getByRole('menuitem', { name: '恢复对话', exact: true }).click();
    await expect(page.locator('.archived-banner')).not.toBeVisible();
    await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toBeEnabled();
    await page.getByRole('button', { name: '返回最近对话' }).click();
    await expect(row).toBeVisible();
    expect((await (await request.get('/api/state')).json()).conversations.find(c => c.id === pinnedId).pinnedAt).toBeNull();
    await other.close();

    await page.getByRole('button', { name: '新建标签页' }).click();
    await page.getByRole('button', { name: /新建终端/ }).click();
    state = await (await request.get('/api/state')).json();
    terminal = state.terminals.find(t => t.workspaceId === a.workspaceId);
    expect(terminal.cwd).toBe(project);
    await page.locator('.terminal-view.visible .xterm-helper-textarea').focus();
    await page.keyboard.type('pwd'); await page.keyboard.press('Enter');
    await expect.poll(async () => (await (await request.get('/api/state')).json()).terminals.find(t => t.id === terminal.id).replay).toContain(project);
    await chooseWorkspace(page, original.name);
    await expect(page.getByRole('textbox', { name: '发送给 Codex' })).toHaveValue('留在原工作区的草稿');
    await expect(page.locator(`[data-conversation-id="${originalChat}"]`)).toBeVisible();
    await expect(page.getByRole('tab', { name: '终端', exact: true })).toHaveCount(0);
    await chooseWorkspace(page, '项目 A');
    await expect(row).toBeVisible();
    await expect(page.getByRole('tab', { name: '终端', exact: true })).toBeVisible();
    await page.screenshot({ path: '.data/sidebar-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.getByRole('button', { name: '收起侧栏' }).isVisible()) await page.getByRole('button', { name: '收起侧栏' }).click();
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await row.getByRole('button', { name: '对话操作：需要固定的对话', exact: true }).click();
    const bounds = await page.getByRole('menu', { name: '对话操作' }).boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: '.data/sidebar-mobile.png' });
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    if (terminal) await request.delete(`/api/terminals/${terminal.id}`);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
