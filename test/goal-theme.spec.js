import { test, expect } from '@playwright/test';

test('goal controls, complete execution folding and neutral dark backgrounds work together', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/state')).json();
  const c = { ...snapshot.conversations[0], id: 'goal-theme-ui', workspaceId: snapshot.defaultWorkspaceId, nativeHistory: false, status: 'idle', activeTurnId: null, goal: null,
    turns: [{ id: 'history', status: 'completed', items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '运行检查' }] },
      { id: 'r', type: 'reasoning', summary: ['中间思考'] },
      { id: 'c1', type: 'commandExecution', command: 'echo FIRST', status: 'completed', exitCode: 0, aggregatedOutput: 'FIRST_OUTPUT' },
      { id: 'comment', type: 'agentMessage', phase: 'commentary', text: '中间执行日志' },
      { id: 'tool', type: 'mcpToolCall', server: 'local', tool: 'exec', status: 'completed', result: { output: 'TOOL_OUTPUT' } },
      { id: 'r2', type: 'reasoning', summary: ['继续分析'] },
      { id: 'c2', type: 'commandExecution', command: 'echo SECOND', status: 'completed', exitCode: 0 },
      { id: 'file', type: 'fileChange', status: 'completed', changes: [] },
      { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '最终检查结果' },
    ] }] };
  snapshot.conversations = [c]; snapshot.terminals = []; snapshot.approvals = [];
  let socket, goal = null; const mutations = [];
  await page.routeWebSocket('**/ws', ws => { socket = ws; ws.send(JSON.stringify(snapshot)); });
  await page.route('**/api/conversations/*/goal', async route => {
    if (route.request().method() === 'POST') {
      const data = route.request().postDataJSON(); mutations.push(data);
      if (data.operation === 'clear') goal = null;
      else if (data.operation === 'create') goal = { objective: data.objective, tokenBudget: data.tokenBudget, status: 'active', tokensUsed: 0, timeUsedSeconds: 0, threadId: c.threadId };
      else if (data.operation === 'budget') goal = { ...goal, tokenBudget: data.tokenBudget };
      else goal = { ...goal, status: data.operation === 'pause' ? 'paused' : 'active' };
      c.goal = goal; c.status = goal?.status === 'active' ? 'active' : 'idle'; socket.send(JSON.stringify({ type: 'conversation', conversation: c }));
    }
    await route.fulfill({ json: { goal } });
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.main-panel')).toHaveCSS('background-color', 'rgb(39, 44, 53)');
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(32, 37, 46)');
  await expect(page.locator('.composer')).toHaveCSS('background-color', 'rgb(52, 60, 73)');
  const group = page.locator('.execution-group'); await expect(group).toHaveCount(1); await expect(group).not.toHaveAttribute('open');
  await expect(group.locator(':scope>summary')).toContainText('4 项');
  await expect(page.getByText('中间执行日志', { exact: true })).not.toBeVisible();
  await expect(page.getByText('最终检查结果', { exact: true })).toBeVisible();
  await group.locator(':scope>summary').click(); await group.locator('.tool-activity').first().locator('summary').click();
  await expect(page.getByText('FIRST_OUTPUT', { exact: true })).toBeVisible();
  c.turns[0].items.splice(-1, 0, { id: 'c3', type: 'commandExecution', command: 'echo THIRD', status: 'inProgress' });
  socket.send(JSON.stringify({ type: 'conversation', conversation: c }));
  await expect(group).toHaveAttribute('open'); await expect(group.locator(':scope>summary')).toContainText('5 项');
  await group.locator(':scope>summary').click();
  const input = page.getByRole('textbox', { name: '发送给 Codex' });
  await input.fill('/go'); await expect(page.getByRole('option')).toHaveCount(1); await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '目标任务' }); await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '目标描述' }).fill('验证目标面板');
  await dialog.getByRole('spinbutton', { name: 'Token 预算（可选）' }).fill('10000');
  await dialog.getByRole('button', { name: '设置并开始' }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.locator('.goal-bar')).toHaveCount(0);
  await input.fill('/goal status'); await input.press('Enter'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '暂停目标' }).click(); await expect(dialog).toContainText('已暂停');
  await dialog.getByRole('spinbutton', { name: 'Token 预算（可选）' }).fill('20000');
  await dialog.getByRole('button', { name: '更新预算' }).click(); await expect(dialog).toContainText('20,000');
  await dialog.getByRole('button', { name: '继续目标' }).click(); await expect(dialog).toContainText('进行中');
  await dialog.getByRole('button', { name: '清除目标' }).click(); await expect(page.getByRole('button', { name: '管理当前目标' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭窗口' }).click();
  expect(mutations.map(item => item.operation)).toEqual(['create', 'pause', 'budget', 'resume', 'clear']);
  await page.screenshot({ path: '.data/dark-execution-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.getByRole('button', { name: '收起侧栏' }).isVisible()) await page.getByRole('button', { name: '收起侧栏' }).click();
  await input.fill('/goal'); await input.press('Enter'); await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '.data/dark-goal-mobile.png' });
});
