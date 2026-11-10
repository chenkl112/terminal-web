import { test as base, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';

// This fixture serves the built UI with invented data and never starts the real
// application server, reads its state, or connects to a Codex process.
const test = base.extend({
  harness: async ({ page }, use) => {
    const workspaces = [
      { id: 'workspace-a', name: 'terminal-web', path: '/tmp/ui-fixture/terminal-web' },
      { id: 'workspace-b', name: '设计实验室', path: '/tmp/ui-fixture/design-lab' },
    ];
    const makeConversation = (id, title, workspace, updatedAt, pinnedAt = null) => ({
      id, title, workspaceId: workspace.id, cwd: workspace.path, status: 'idle', activeTurnId: null,
      model: 'gpt-5.4', effort: 'medium', permissionMode: 'workspace-write', mode: 'default',
      createdAt: updatedAt, updatedAt, pinnedAt, archivedAt: null, attachments: {},
      turns: [{ id: `${id}-turn`, status: 'completed', items: [
        { id: `${id}-question`, type: 'userMessage', content: [{ type: 'text', text: '帮我梳理这个项目的界面和操作流程。' }] },
        { id: `${id}-answer`, type: 'agentMessage', text: '可以从三个常用操作开始：\n\n- 在侧栏查找和切换对话。\n- 在输入框保留尚未发送的想法。\n- 用标签页切换任务与终端。\n\n这样每次回到项目，都可以接着上次的工作继续。' },
      ] }],
    });
    const conversations = [
      makeConversation('project-overview', '项目结构与下一步', workspaces[0], 1730000000000, 1730000000000),
      makeConversation('design-review', '界面设计评审', workspaces[0], 1730000001000),
      makeConversation('keyboard-notes', '键盘快捷操作', workspaces[0], 1730000002000),
      makeConversation('design-lab', '组件探索', workspaces[1], 1730000003000),
    ];
    const snapshot = {
      type: 'snapshot', codexStatus: 'ready', workspaces, defaultWorkspaceId: workspaces[0].id,
      models: [{ id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: true,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '适合日常任务' }] }],
      conversations, approvals: [],
      terminals: workspaces.map(workspace => ({
        id: `default-${workspace.id}`, workspaceId: workspace.id, cwd: workspace.path,
        title: 'Codex 终端', isDefault: true, exited: false, replay: '', cols: 100, rows: 30,
      })),
    };
    const deleted = [], pendingTasks = [], unexpectedRequests = [], browserErrors = [], expectedHttpErrors = new Set();
    const controls = { deleteFailures: 0 };
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const location = message.location().url;
      const expectedFailure = location && expectedHttpErrors.has(new URL(location).pathname)
        && /Failed to load resource:.*status of 503/.test(message.text());
      if (!expectedFailure) browserErrors.push(message.text());
    });
    const app = express();
    app.use(express.json());
    app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.get('/api/resources/metrics', (_, res) => res.json({ timestamp: Date.now(), processCount: 0, cpu: { appPercent: 0, systemPercent: 0 }, memory: { appRss: 0, used: 0, total: 1 }, network: { receivePerSecond: 0, sendPerSecond: 0, interfaces: [] }, groups: [] }));
    app.get('/favicon.ico', (_, res) => res.sendStatus(204));
    app.post('/api/tasks', (req, res) => {
      pendingTasks.push({ body: req.body, respond(error) {
        if (error) {
          expectedHttpErrors.add('/api/tasks');
          res.status(503).json({ error });
          return;
        }
        const workspace = workspaces.find(item => item.id === req.body.workspaceId);
        const conversation = makeConversation(`submitted-${pendingTasks.length}`, '界面实现计划', workspace, Date.now());
        conversation.turns = [{ id: `${conversation.id}-turn`, status: 'completed', items: [
          { id: `${conversation.id}-question`, type: 'userMessage', content: [{ type: 'text', text: req.body.text }] },
        ] }];
        snapshot.conversations.push(conversation);
        broadcast({ type: 'conversation', conversation });
        res.json({ conversation });
      } });
    });
    app.post('/api/terminals/default', (req, res) => {
      res.json(snapshot.terminals.find(terminal => terminal.isDefault && terminal.workspaceId === req.body.workspaceId));
    });
    app.post('/api/terminals', (req, res) => {
      const workspace = workspaces.find(item => item.id === req.body.workspaceId);
      const terminal = { id: 'build-terminal', workspaceId: workspace.id, cwd: workspace.path,
        title: '构建终端', isDefault: false, exited: false, replay: '$ npm run build\r\n正在构建项目…\r\n', cols: 100, rows: 30 };
      snapshot.terminals.push(terminal);
      broadcast({ type: 'terminal/created', terminal });
      res.json(terminal);
    });
    app.delete('/api/terminals/:id', (req, res) => {
      if (controls.deleteFailures > 0) {
        controls.deleteFailures--;
        expectedHttpErrors.add(req.originalUrl);
        res.status(503).json({ error: '终端暂时无法关闭，请重试' });
        return;
      }
      deleted.push(req.params.id);
      snapshot.terminals = snapshot.terminals.filter(terminal => terminal.id !== req.params.id);
      broadcast({ type: 'terminal/deleted', id: req.params.id });
      res.json({ ok: true });
    });
    app.use('/api', (req, res) => {
      unexpectedRequests.push(`${req.method} ${req.originalUrl}`);
      res.status(501).json({ error: '此界面测试未实现该 API' });
    });
    app.use(express.static('dist'));
    const server = createServer(app);
    const wss = new WebSocketServer({ server, path: '/ws' });
    function broadcast(message) {
      for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    }
    wss.on('connection', socket => socket.send(JSON.stringify(snapshot)));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await mkdir('.data/harness-ui', { recursive: true });
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await expect(page.getByRole('textbox', { name: '发送给 Codex', exact: true })).toBeEnabled();
      await use({ deleted, snapshot, controls, pendingTasks });
      expect(unexpectedRequests, 'The UI should only use the isolated fixture APIs').toEqual([]);
      expect(browserErrors, 'The interface should not produce browser errors').toEqual([]);
    } finally {
      await page.goto('about:blank');
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  },
});

const composer = page => page.getByRole('textbox', { name: '发送给 Codex', exact: true });
const chatRow = (page, id) => page.locator(`[data-conversation-id="${id}"] .conversation-link`);

async function openSidebar(page) {
  const open = page.getByRole('button', { name: '展开侧栏', exact: true });
  if (await open.isVisible()) await open.click();
}

async function newTask(page) {
  await openSidebar(page);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.locator('.header-title')).toHaveText('新建任务');
}

async function chooseWorkspace(page, name) {
  await openSidebar(page);
  await page.getByRole('button', { name: '选择工作区', exact: true }).click();
  await page.getByRole('menuitem').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click();
}

async function noHorizontalOverflow(page) {
  expect(await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth })))
    .toEqual({ document: page.viewportSize().width, viewport: page.viewportSize().width });
}

test('unsent new tasks survive repeated creation, conversation switches, workspace switches, and reload', async ({ page, harness }) => {
  await newTask(page);
  await composer(page).fill('保留我还没有发送的界面改进计划');
  await newTask(page);
  await expect(composer(page)).toHaveValue('保留我还没有发送的界面改进计划');

  await chatRow(page, 'design-review').click();
  await expect(composer(page)).toHaveValue('');
  await composer(page).fill('这是已有对话自己的草稿');
  await newTask(page);
  await expect(composer(page)).toHaveValue('保留我还没有发送的界面改进计划');

  await chooseWorkspace(page, '设计实验室');
  await newTask(page);
  await composer(page).fill('另一个工作区的独立想法');
  await chooseWorkspace(page, 'terminal-web');
  await newTask(page);
  await expect(composer(page)).toHaveValue('保留我还没有发送的界面改进计划');
  await page.reload();
  await expect(page.locator('.header-title')).toHaveText('新建任务');
  await expect(composer(page)).toHaveValue('保留我还没有发送的界面改进计划');

  await chatRow(page, 'design-review').click();
  await expect(composer(page)).toHaveValue('这是已有对话自己的草稿');
  await chooseWorkspace(page, '设计实验室');
  await newTask(page);
  await expect(composer(page)).toHaveValue('另一个工作区的独立想法');
  expect(harness.snapshot.conversations).toHaveLength(4);
});

test('welcome suggestions append to the current draft and keep the composer focused', async ({ page, harness }) => {
  await newTask(page);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: '.data/harness-ui/desktop-welcome.png', animations: 'disabled' });
  await composer(page).fill('先保留我自己的需求。');
  await page.getByRole('button', { name: '探索项目', exact: true }).click();
  await expect(composer(page)).toBeFocused();
  const exploration = await composer(page).inputValue();
  expect(exploration).toMatch(/^先保留我自己的需求。\s+查看当前工作目录/);
  await page.getByRole('button', { name: '编写代码', exact: true }).click();
  await expect(composer(page)).toBeFocused();
  const implementation = await composer(page).inputValue();
  expect(implementation.startsWith(exploration)).toBeTruthy();
  expect(implementation).toContain('帮我实现一个功能：');
  await chatRow(page, 'design-review').click();
  await page.screenshot({ path: '.data/harness-ui/desktop-conversation.png', animations: 'disabled' });
});

test('typing while the first task is being sent survives a delayed success or failure', async ({ page, harness }) => {
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  await newTask(page);
  await composer(page).fill('第一条已提交的任务');
  await send.click();
  await expect.poll(() => harness.pendingTasks.length).toBe(1);
  await expect(send).toBeDisabled();
  await composer(page).fill('等待响应时想到的补充要求');
  harness.pendingTasks[0].respond();
  await expect(page.locator('.header-title')).toHaveText('界面实现计划');
  await expect(composer(page)).toHaveValue('等待响应时想到的补充要求');
  await expect(page.locator('.user-bubble')).toHaveText('第一条已提交的任务');
  await page.reload();
  await expect(composer(page)).toHaveValue('等待响应时想到的补充要求');

  await newTask(page);
  await composer(page).fill('第二个任务的初稿');
  await send.click();
  await expect.poll(() => harness.pendingTasks.length).toBe(2);
  await composer(page).fill('请求失败也必须保留的修改');
  harness.pendingTasks[1].respond('暂时无法创建任务，请重试');
  await expect(page.getByRole('alert')).toContainText('暂时无法创建任务，请重试');
  await expect(page.locator('.header-title')).toHaveText('新建任务');
  await expect(composer(page)).toHaveValue('请求失败也必须保留的修改');
  await expect(send).toBeEnabled();
  expect(harness.snapshot.conversations).toHaveLength(5);
  await send.click();
  await expect.poll(() => harness.pendingTasks.length).toBe(3);
  expect(harness.pendingTasks[2].body.text).toBe('请求失败也必须保留的修改');
  harness.pendingTasks[2].respond();
  await expect(page.locator('.header-title')).toHaveText('界面实现计划');
  await expect(page.locator('.user-bubble')).toHaveText('请求失败也必须保留的修改');
  await expect(composer(page)).toHaveValue('');
});

test('Ctrl+K opens and focuses sidebar search; Escape closes it and clears its filter', async ({ page, harness }) => {
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await composer(page).fill('搜索不应清空输入内容');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('textbox', { name: '搜索对话', exact: true });
  await expect(search).toBeFocused();
  await search.fill('界面设计');
  await expect(page.locator('.conversation-row')).toHaveCount(1);
  await expect(chatRow(page, 'design-review')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(page.locator('.conversation-row')).toHaveCount(3);
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await expect(composer(page)).toHaveValue('搜索不应清空输入内容');
});

test('closing a running terminal requires confirmation and cancellation keeps it available', async ({ page, harness }) => {
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  const terminal = page.getByRole('tab', { name: '构建终端', exact: true });
  await expect(terminal).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.terminal-view.visible .xterm')).toBeVisible();
  await page.getByRole('button', { name: '关闭 构建终端', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '关闭终端', exact: true });
  await expect(confirmation).toBeVisible();
  expect(harness.deleted).toEqual([]);
  await page.screenshot({ path: '.data/harness-ui/desktop-terminal-confirmation.png', animations: 'disabled' });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(terminal).toBeVisible();
  expect(harness.deleted).toEqual([]);
  await page.getByRole('button', { name: '关闭 构建终端', exact: true }).click();
  harness.controls.deleteFailures = 1;
  await confirmation.getByRole('button', { name: '关闭终端', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('终端暂时无法关闭，请重试');
  await expect(terminal).toBeVisible();
  expect(harness.deleted).toEqual([]);
  await expect(confirmation.getByRole('button', { name: '关闭终端', exact: true })).toBeEnabled();
  await confirmation.getByRole('button', { name: '关闭终端', exact: true }).click();
  await expect(terminal).toHaveCount(0);
  await expect(confirmation).toHaveCount(0);
  expect(harness.deleted).toEqual(['build-terminal']);
  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test.describe('phone workspace', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('welcome and conversation fit the screen, and selecting a search result closes the drawer', async ({ page, harness }) => {
    await newTask(page);
    await expect(page.getByRole('heading', { name: '从一个想法开始', exact: true })).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: '.data/harness-ui/mobile-welcome.png', animations: 'disabled' });
    await composer(page).fill('long-unbroken-draft-'.repeat(25));
    await noHorizontalOverflow(page);
    await page.keyboard.press('Control+k');
    const search = page.getByRole('textbox', { name: '搜索对话', exact: true });
    await expect(search).toBeFocused();
    await search.fill('界面设计');
    await expect(chatRow(page, 'design-review')).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: '.data/harness-ui/mobile-search.png', animations: 'disabled' });
    await chatRow(page, 'design-review').click();
    await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
    await expect(page.locator('.header-title')).toHaveText('界面设计评审');
    await expect(page.getByRole('textbox', { name: '搜索对话', exact: true })).toHaveCount(0);
    await expect(composer(page)).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: '.data/harness-ui/mobile-conversation.png', animations: 'disabled' });
  });
});
