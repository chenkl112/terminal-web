import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

test('an upload started during task creation finishes in the real conversation and can be sent', async ({ page }) => {
  // Serve the built interface against invented state; no real application or
  // Codex service participates in this ordering-sensitive upload scenario.
  const workspace = { id: 'attachment-workspace', name: '附件测试', path: '/tmp/harness-attachments' };
  const snapshot = {
    type: 'snapshot', codexStatus: 'ready', workspaces: [workspace], defaultWorkspaceId: workspace.id,
    models: [], conversations: [], approvals: [],
    terminals: [{ id: 'fixture-terminal', title: 'Codex 终端', workspaceId: workspace.id,
      isDefault: true, exited: false, replay: '', cols: 100, rows: 30 }],
  };
  const pendingTasks = [], pendingChunks = [], sentMessages = [], unexpectedRequests = [], browserErrors = [];
  let upload, completedUploads = 0;
  page.on('pageerror', error => browserErrors.push(error.message));

  const app = express();
  app.use(express.json());
  app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.get('/api/resources/metrics', (_, res) => res.json({ timestamp: Date.now(), processCount: 0, cpu: { appPercent: 0, systemPercent: 0 }, memory: { appRss: 0, used: 0, total: 1 }, network: { receivePerSecond: 0, sendPerSecond: 0, interfaces: [] }, groups: [] }));
  app.get('/favicon.ico', (_, res) => res.sendStatus(204));
  app.post('/api/tasks', (req, res) => {
    pendingTasks.push({ body: req.body, respond() {
      const conversation = {
        id: 'created-task', threadId: 'created-thread', title: '带附件的任务', workspaceId: workspace.id,
        cwd: workspace.path, status: 'idle', activeTurnId: null, attachments: {},
        permissionMode: 'workspace-write', mode: 'default', createdAt: Date.now(), updatedAt: Date.now(),
        turns: [{ id: 'first-turn', status: 'completed', items: [
          { id: 'first-message', type: 'userMessage', content: [{ type: 'text', text: req.body.text }] },
        ] }],
      };
      snapshot.conversations.push(conversation);
      res.json({ conversation });
    } });
  });
  app.post('/api/uploads/start', (req, res) => {
    upload = req.body;
    res.json({ offset: 0 });
  });
  app.put('/api/uploads/:id/content', express.raw({ type: 'application/octet-stream' }), (req, res) => {
    pendingChunks.push({ id: req.params.id, bytes: req.body.length,
      respond() { res.json({ offset: Number(req.query.offset) + req.body.length }); } });
  });
  app.post('/api/uploads/:id/complete', (req, res) => {
    completedUploads++;
    res.json({ id: req.params.id, name: upload.name, size: upload.size, image: false,
      path: `${workspace.path}/${upload.name}`, url: `/api/uploads/${req.params.id}` });
  });
  app.post('/api/uploads/keepalive', (_, res) => res.json({ missing: [] }));
  app.post('/api/conversations/:id/messages', (req, res) => {
    sentMessages.push({ conversationId: req.params.id, body: req.body });
    res.json({ ok: true });
  });
  app.use('/api', (req, res) => {
    unexpectedRequests.push(`${req.method} ${req.originalUrl}`);
    res.status(501).json({ error: '此界面测试未实现该 API' });
  });
  app.use(express.static('dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => socket.send(JSON.stringify(snapshot)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const composer = page.getByRole('textbox', { name: '发送给 Codex', exact: true });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await expect(composer).toBeEnabled();
    await composer.fill('先创建任务，附件稍后补充');
    await send.click();
    await expect.poll(() => pendingTasks.length).toBe(1);
    expect(pendingTasks[0].body.attachments).toEqual([]);

    await composer.fill('补充这份文件');
    const contents = Buffer.from('Attachment added while the first task request is still pending.\n');
    await page.getByLabel('选择上传文件', { exact: true }).setInputFiles({
      name: 'requirements.txt', mimeType: 'text/plain', buffer: contents,
    });
    await expect.poll(() => pendingChunks.length).toBe(1);
    expect(pendingChunks[0]).toMatchObject({ id: upload.id, bytes: contents.length });
    const attachment = page.getByTestId('upload-card');
    await expect(attachment).toContainText('requirements.txt');
    await expect(attachment.getByRole('progressbar', { name: '上传进度' })).toBeVisible();

    // Create the real conversation before allowing any successful chunk or
    // completion response to update the upload's original draft owner.
    pendingTasks[0].respond();
    await expect(page.locator('.header-title')).toHaveText('带附件的任务');
    await expect(composer).toHaveValue('补充这份文件');
    await expect(attachment.getByRole('progressbar', { name: '上传进度' })).toBeVisible();
    await expect(send).toBeDisabled();
    pendingChunks[0].respond();
    await expect.poll(() => completedUploads).toBe(1);
    await expect(attachment.getByRole('img', { name: '上传完成' })).toBeVisible();
    await expect(send).toBeEnabled();

    // Reload also verifies that completed metadata was persisted under the
    // server conversation, rather than resurrecting the obsolete draft ID.
    await page.reload();
    await expect(page.locator('.header-title')).toHaveText('带附件的任务');
    await expect(composer).toHaveValue('补充这份文件');
    await expect(attachment.getByRole('img', { name: '上传完成' })).toBeVisible();
    await send.click();
    await expect.poll(() => sentMessages.length).toBe(1);
    expect(sentMessages[0]).toMatchObject({
      conversationId: 'created-task', body: { text: '补充这份文件', attachments: [upload.id] },
    });
    await expect(attachment).toHaveCount(0);
    await expect(composer).toHaveValue('');
    expect(unexpectedRequests).toEqual([]);
    expect(browserErrors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
