import { test, expect } from '@playwright/test';

async function command(page, text) {
  const input = page.getByRole('textbox', { name: '发送给 Codex' });
  await input.fill(text); await input.press('Enter');
}

test('Fast persists, slash completion supports keyboard selection and executes settings and local commands', async ({ page, request }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  const fast = page.getByRole('button', { name: 'Fast 模式', exact: true });
  await expect(fast).toBeEnabled(); await fast.click(); await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await page.reload(); await page.getByRole('tab', { name: 'Codex', exact: true }).click(); await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await command(page, '/fast off'); await expect(fast).toHaveAttribute('aria-pressed', 'false');
  const input = page.getByRole('textbox', { name: '发送给 Codex' });
  await input.fill('/mod'); await expect(page.getByRole('option')).toHaveCount(1);
  await input.press('Tab'); await expect(input).toHaveValue('/model ');
  await input.press('Enter'); await expect(page.getByRole('menu', { name: '选择模型', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await command(page, '/effort medium'); await expect(page.getByRole('button', { name: '选择思考深度', exact: true })).toHaveText('中');
  await command(page, '/permissions readonly'); await expect(page.getByRole('button', { name: '选择权限', exact: true })).toHaveText('只读');
  await expect(page.getByRole('button', { name: '选择权限', exact: true })).toBeEnabled();
  await command(page, '/permissions full'); await expect(page.getByRole('button', { name: '选择权限', exact: true })).toHaveText('完全访问');
  await command(page, '/plan on'); await expect(page.getByRole('button', { name: '退出规划模式' })).toBeVisible();
  await command(page, '/plan off'); await expect(page.getByRole('button', { name: '退出规划模式' })).toHaveCount(0);
  await command(page, '/status'); const status = page.getByRole('dialog', { name: '当前会话' });
  await expect(status).toContainText('完全访问'); await status.getByRole('button', { name: '关闭窗口' }).click();
  await command(page, '/skills'); const skills = page.getByRole('dialog', { name: '选择技能' });
  await expect(skills.locator('.command-skills>button').first()).toBeVisible(); await skills.locator('.command-skills>button:not(:disabled)').first().click();
  await expect(input).toHaveValue(/^\$/);
  await command(page, '/help'); const help = page.getByRole('dialog', { name: '斜杠命令' }); await expect(help).toContainText('/compact');
  await help.getByRole('button', { name: '关闭窗口' }).click();
  await command(page, '/history'); const history = page.getByRole('dialog', { name: '全部历史会话' }); await expect(history).toBeVisible(); await history.getByRole('button', { name: '关闭窗口' }).click();
  let sent = 0; page.on('request', request => { if (/\/messages$/.test(request.url())) sent++; });
  await command(page, '/unknown-command'); await expect(page.getByRole('alert')).toContainText('未知命令'); await expect(input).toHaveValue('/unknown-command'); expect(sent).toBe(0);
  const state = await (await request.get('/api/state')).json(); const before = state.conversations.length;
  await input.fill('/new'); await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  expect((await (await request.get('/api/state')).json()).conversations.length).toBe(before);
  await input.press('Escape'); await input.fill('/new'); await input.press('Enter');
  await expect(page.locator('.header-title')).toHaveText('新建任务');
  expect((await (await request.get('/api/state')).json()).conversations.length).toBe(before);
  await page.locator('.conversation-row .conversation-link').first().click();
  await command(page, '/rename 命令测试'); await expect(page.locator('.header-title')).toHaveText('命令测试');
  await command(page, '/archive'); await expect(page.locator('.archived-banner')).toBeVisible();
  await page.getByRole('button', { name: '恢复对话', exact: true }).click(); await expect(input).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.getByRole('button', { name: '收起侧栏' }).isVisible()) await page.getByRole('button', { name: '收起侧栏' }).click();
  await input.fill('/'); await expect(page.getByRole('listbox', { name: '斜杠命令' })).toBeVisible();
  const bounds = await page.locator('.slash-menu').boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390); expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '.data/fast-slash-mobile.png' });
  expect(errors).toEqual([]);
});
