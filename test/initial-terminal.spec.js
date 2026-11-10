import { test as base, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { terminalManager, terminalInfo } from '../server/terminals.js';

const test = base.extend({
  harness: async ({}, use) => {
    const terminals = new Map(), children = [], input = [], requests = [], deleted = [];
    const workspaces = [{ id: 'project', name: 'Project', path: '/tmp' }, { id: 'other', name: 'Other', path: '/tmp' }];
    const conversations = workspaces.map(w => ({ id: `chat-${w.id}`, workspaceId: w.id, title: '聊天', status: 'idle', turns: [], attachments: {} }));
    const snapshot = () => ({ type: 'snapshot', codexStatus: 'ready', models: [], workspaces, defaultWorkspaceId: 'project', conversations, terminals: [...terminals.values()].map(t => ({ ...terminalInfo(t), replay: t.replay })), approvals: [] });
    const app = express(); app.use(express.json());
    app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
    app.get('/api/resources/metrics', (_, res) => res.json({ timestamp: Date.now(), processCount: 0, cpu: { appPercent: 0, systemPercent: 0 }, memory: { appRss: 0, used: 0, total: 1 }, network: { receivePerSecond: 0, sendPerSecond: 0, interfaces: [] }, groups: [] }));
    const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
    const broadcast = event => { for (const socket of wss.clients) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); };
    const manager = terminalManager({ state: { workspaces }, defaultWorkspaceId: 'project', terminals, broadcast, spawn() {
      const child = { killed: false, onData(fn) { this.output = fn; }, onExit(fn) { this.exit = fn; }, write(data) { input.push(data); this.output(data); }, resize() {}, kill() { this.killed = true; this.exit({ exitCode: 0 }); } };
      children.push(child); return child;
    } });
    app.use('/api/terminals', (req, res, next) => {
      if (req.method === 'POST') requests.push({ path: req.path, workspaceId: req.body?.workspaceId });
      if (req.method === 'DELETE') deleted.push(req.path.slice(1));
      next();
    }, manager.router);
    app.use(express.static(process.env.TERMINAL_TEST_DIST || 'dist'));
    let connections = 0;
    wss.on('connection', socket => {
      connections++;
      socket.send(JSON.stringify(snapshot()));
      socket.on('message', raw => {
        const message = JSON.parse(raw);
        if (message.type === 'terminal/input') terminals.get(message.id)?.pty.write(message.data);
      });
    });
    server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      await use({ origin: `http://127.0.0.1:${server.address().port}`, terminals, children, input, requests, deleted, manager,
        async reconnect() {
          const before = connections, count = wss.clients.size;
          for (const socket of wss.clients) socket.close();
          await expect.poll(() => connections).toBeGreaterThanOrEqual(before + count);
        },
      });
    } finally {
      for (const socket of wss.clients) socket.terminate();
      wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  },
});

const terminalTab = page => page.getByRole('tab', { name: '终端', exact: true });
const chatTab = page => page.getByRole('tab', { name: 'Codex', exact: true });
const closeTab = page => page.getByRole('button', { name: '关闭 终端', exact: true });
const confirmation = page => page.getByRole('dialog', { name: '关闭终端', exact: true });
async function openTerminal(page, codex = true) {
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await page.getByRole('button', { name: codex ? '打开 Codex 终端' : '新建终端', exact: true }).click();
  await expect(terminalTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.terminal-view.visible .xterm')).toBeVisible();
}
async function chooseWorkspace(page, name) {
  await page.getByRole('button', { name: '选择工作区', exact: true }).click();
  await page.getByRole('menuitem').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click();
  await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toHaveText(name);
}

test('initial load, refresh, reconnect and workspace switching leave terminals closed', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(terminalTab(page)).toHaveCount(0);
  await page.reload();
  await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
  await chooseWorkspace(page, 'Other');
  await chooseWorkspace(page, 'Project');
  await harness.reconnect();
  await expect(page.locator('.connection-banner')).toHaveCount(0);
  await expect(terminalTab(page)).toHaveCount(0);
  expect(harness.requests).toEqual([]);
  expect(harness.children).toHaveLength(0);
  expect(harness.terminals.size).toBe(0);
});

test('existing shared Codex terminals can be cancelled, closed and explicitly reopened with a fresh ID', async ({ page, browser, harness }) => {
  const initial = harness.manager.ensureDefault('project');
  expect(initial.isDefault).toBe(true);
  const otherContext = await browser.newContext(), other = await otherContext.newPage();
  try {
    await Promise.all([page.goto(harness.origin), other.goto(harness.origin)]);
    await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(chatTab(other)).toHaveAttribute('aria-selected', 'true');
    await expect(closeTab(page)).toBeVisible();
    await expect(closeTab(other)).toBeVisible();
    expect(harness.requests).toEqual([]);

    // Explicitly opening an existing shared Codex terminal selects it without spawning another process.
    await openTerminal(page);
    await openTerminal(other);
    expect(harness.requests).toEqual([{ path: '/default', workspaceId: 'project' }, { path: '/default', workspaceId: 'project' }]);
    expect(harness.children).toHaveLength(1);
    expect(harness.input).toHaveLength(0);
    harness.children[0].output('shared terminal output\r\n');
    await expect(page.locator('.terminal-view.visible .xterm-screen')).toContainText('shared terminal output');
    await expect(other.locator('.terminal-view.visible .xterm-screen')).toContainText('shared terminal output');
    await page.reload();
    await expect(terminalTab(page)).toHaveAttribute('aria-selected', 'true');
    expect(harness.children).toHaveLength(1);

    await closeTab(page).click();
    await expect(confirmation(page)).toBeVisible();
    expect(harness.deleted).toEqual([]);
    await confirmation(page).getByRole('button', { name: '取消', exact: true }).click();
    await expect(confirmation(page)).toHaveCount(0);
    await expect(terminalTab(page)).toBeVisible();
    expect(harness.children[0].killed).toBe(false);
    expect(harness.deleted).toEqual([]);

    await closeTab(page).click();
    await confirmation(page).getByRole('button', { name: '关闭终端', exact: true }).click();
    await expect(terminalTab(page)).toHaveCount(0);
    await expect(terminalTab(other)).toHaveCount(0);
    await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(chatTab(other)).toHaveAttribute('aria-selected', 'true');
    expect(harness.deleted).toEqual([initial.id]);
    expect(harness.children[0].killed).toBe(true);
    expect(harness.terminals.size).toBe(0);
    await Promise.all([page.reload(), other.reload()]);
    await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(chatTab(other)).toHaveAttribute('aria-selected', 'true');
    await harness.reconnect();
    await expect(page.locator('.connection-banner')).toHaveCount(0);
    await expect(other.locator('.connection-banner')).toHaveCount(0);
    await expect(terminalTab(page)).toHaveCount(0);
    await expect(terminalTab(other)).toHaveCount(0);
    expect(harness.requests).toHaveLength(2);
    expect(harness.children).toHaveLength(1);

    await openTerminal(other);
    await expect(terminalTab(page)).toBeVisible();
    expect(harness.children).toHaveLength(2);
    expect(harness.terminals.size).toBe(1);
    const reopened = [...harness.terminals.values()][0];
    expect(reopened.id).not.toBe(initial.id);
    expect(reopened.isDefault).toBe(true);
    expect(harness.requests.at(-1)).toEqual({ path: '/default', workspaceId: 'project' });
  } finally { await otherContext.close(); }
});

test.describe('phone terminal tabs', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('both Codex and shell terminals expose a usable close button on mobile', async ({ page, harness }) => {
    await page.goto(harness.origin);
    await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
    for (const codex of [true, false]) {
      await openTerminal(page, codex);
      const current = [...harness.terminals.values()][0];
      expect(current.isDefault).toBe(codex);
      expect(harness.requests.at(-1)).toEqual({ path: codex ? '/default' : '/', workspaceId: 'project' });
      await expect(closeTab(page)).toBeVisible();
      await closeTab(page).tap();
      await expect(confirmation(page)).toBeVisible();
      await confirmation(page).getByRole('button', { name: '关闭终端', exact: true }).tap();
      await expect(terminalTab(page)).toHaveCount(0);
      await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
      expect(harness.deleted).toContain(current.id);
      expect(harness.children.at(-1).killed).toBe(true);
      expect(harness.terminals.size).toBe(0);
    }
    await page.reload();
    await expect(chatTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(terminalTab(page)).toHaveCount(0);
    expect(harness.children).toHaveLength(2);
    expect(harness.requests).toHaveLength(2);
  });
});
