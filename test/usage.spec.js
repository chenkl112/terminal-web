import { test, expect } from '@playwright/test';

test('left-aligned usage controls show independent real token and context details on hover and click', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/state')).json();
  const conversation = { ...snapshot.conversations[0], id: 'usage-layout-test', workspaceId: snapshot.defaultWorkspaceId, nativeHistory: false, turns: [], status: 'idle', activeTurnId: null, archivedAt: null,
    usage: { total: { totalTokens: 1399461, inputTokens: 1378172, cachedInputTokens: 1344896, outputTokens: 21289 },
      last: { totalTokens: 54800, inputTokens: 53500, cachedInputTokens: 30000, outputTokens: 1300 }, modelContextWindow: 1000000 } };
  snapshot.conversations = [conversation]; snapshot.terminals = []; snapshot.approvals = [];
  let socket; const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.removeItem('mono-active-tab'));
  await page.routeWebSocket('**/ws', ws => { socket = ws; ws.send(JSON.stringify(snapshot)); });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  const tokens = page.getByRole('button', { name: '查看 token 用量', exact: true });
  const context = page.getByRole('button', { name: '查看 token 和上下文用量', exact: true });
  await expect(tokens).toHaveText('1.4M tok · 缓存命中 98%');
  const left = await tokens.boundingBox(), right = await context.boundingBox();
  expect(right.x - left.x).toBeLessThan(300);
  await tokens.hover();
  const tokenDetails = page.getByRole('region', { name: 'Token 用量详情' });
  await expect(tokenDetails).toContainText('1,399,461 tok');
  await expect(tokenDetails).toContainText('33,276 tok');
  await expect(tokenDetails).toContainText('1,344,896 tok');
  await page.locator('.topbar').hover(); await expect(tokenDetails).not.toBeVisible();
  await context.click();
  const contextDetails = page.getByRole('region', { name: '上下文用量详情' });
  await expect(contextDetails).toContainText('~54.8K / 1M');
  await expect(contextDetails).toContainText('缓存输入');
  conversation.usage.modelContextWindow = 828400;
  socket.send(JSON.stringify({ type: 'conversation', conversation }));
  await expect(contextDetails).toContainText('~54.8K / 828.4K');
  await expect(page.getByTestId('context-percent')).toHaveText('7%');
  await page.keyboard.press('Escape'); await expect(contextDetails).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.getByRole('button', { name: '收起侧栏' }).isVisible()) await page.getByRole('button', { name: '收起侧栏' }).click();
  await tokens.click(); await expect(tokenDetails).toBeVisible();
  const bounds = await tokenDetails.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.data/usage-token-reference-mobile.png' });
  await context.click(); await expect(contextDetails).toBeVisible();
  await page.screenshot({ path: '.data/usage-context-reference-mobile.png' });
  conversation.usage = null; socket.send(JSON.stringify({ type: 'conversation', conversation }));
  await expect(page.getByTestId('context-percent')).toHaveText('—');
  await expect(page.getByTestId('total-tokens')).toHaveText('—');
  expect(errors).toEqual([]);
});
