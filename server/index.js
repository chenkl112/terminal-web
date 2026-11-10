import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Codex } from './codex.js';
import { terminalManager, terminalInfo } from './terminals.js';
import { terminalDownloadsRouter } from './terminalDownloads.js';
import { uploadRouter } from './uploads.js';
import { createUploadCleanup, uploadCleanupSettings } from './uploadCleanup.js';
import { historyRouter } from './history.js';
import { mediaRouter } from './media.js';
import { actionsRouter } from './actions.js';
import { goalsRouter } from './goals.js';
import { createResourceMonitor } from './resources.js';
import { usageStatsRouter } from './usageStats.js';
import { startTask } from './tasks.js';
import { createMessageSender } from './messages.js';
import { createSocketSender } from './socketSender.js';
import { migrateWorkspaces, getWorkspace, workspaceRouter } from './workspaces.js';
import { applyNotification } from '../shared/conversation.js';
import { permissionFor, validateSettings } from '../shared/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
const workspace = path.resolve(process.env.WORKSPACE_DIR || path.join(root, '..'));
const uploadDir = path.join(dataDir, 'uploads');
const stateFile = path.join(dataDir, 'state.json');
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || '0.0.0.0';
const accessKey = process.env.ACCESS_KEY || '';
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true });
let state = { conversations: [], uploads: {} };
if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const defaultWorkspaceId = migrateWorkspaces(state, workspace);
for (const conversation of state.conversations) {
  conversation.status = 'idle';
  conversation.activeTurnId = null;
  delete conversation.goalBusy;
  delete conversation.actionBusy;
  delete conversation.starting;
  delete conversation.archiving;
  conversation.permissionMode ||= 'workspace-write';
  for (const turn of conversation.turns) if (turn.status === 'inProgress') turn.status = 'interrupted';
}
let saveTimer;
function save(immediate = false) {
  clearTimeout(saveTimer);
  const write = () => {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(stateFile + '.tmp', stateFile);
  };
  if (immediate) write(); else saveTimer = setTimeout(write, 250);
}
const uploadCleanup = createUploadCleanup({ state, uploadDir,
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), save, ...uploadCleanupSettings() });
const app = express();
app.disable('x-powered-by');
const server = createServer(app);
// Uploads stream directly to disk and may take arbitrarily long on slow links.
server.requestTimeout = 0;
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
const codex = new Codex();
let models = [];
let modelsError = null;
const terminals = new Map();
const approvals = new Map();
const resources = createResourceMonitor({ root, dataDir, getProcessRoles: () => {
  const roles = new Map();
  if (codex.process?.pid) roles.set(codex.process.pid, { group: 'codex', name: 'Codex 服务' });
  for (const terminal of terminals.values()) if (!terminal.exited && terminal.pty?.pid) roles.set(terminal.pty.pid, { group: 'terminals', name: terminal.isDefault ? 'Codex 终端' : terminal.title });
  return roles;
} });
const loaded = new Set();
const sessions = new Map();
const loginAttempts = new Map();
const socketSenders = new WeakMap();
const send = (socket, message) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (!socketSenders.has(socket)) socketSenders.set(socket, createSocketSender(socket));
  if (message.type === 'conversation/updated' && !socket.conversationPatches) {
    const conversation = conversationByThread(message.conversation.threadId);
    if (conversation) socketSenders.get(socket).send({ type: 'conversation', conversation });
    return;
  }
  socketSenders.get(socket).send(message);
};
const broadcast = message => { for (const socket of wss.clients) send(socket, message); };
const conversationByThread = threadId => state.conversations.find(c => c.threadId === threadId);
const config = () => ({ workspace, defaultWorkspaceId, workspaces: state.workspaces, models, modelsError, codexStatus: codex.status, authEnabled: !!accessKey });
function snapshot() {
  return { type: 'snapshot', ...config(), conversations: state.conversations.filter(c => !c.provisional),
    terminals: [...terminals.values()].map(t => ({ ...terminalInfo(t), replay: t.replay })),
    approvals: [...approvals.values()] };
}
const publishTimers = new Map();
function publish(conversation, change = null) {
  if (conversation.provisional) return;
  const pending = publishTimers.get(conversation.id);
  if (pending) {
    if (!change) pending.full = true;
    if (change?.turnId) pending.turnIds.add(change.turnId);
    return;
  }
  const update = { full: !change, turnIds: new Set(change?.turnId ? [change.turnId] : []) };
  update.timer = setTimeout(() => {
    publishTimers.delete(conversation.id);
    if (update.full) broadcast({ type: 'conversation', conversation });
    else {
      const { turns, ...metadata } = conversation;
      broadcast({ type: 'conversation/updated', conversation: metadata, turns: turns.filter(turn => update.turnIds.has(turn.id)) });
    }
  }, 40);
  publishTimers.set(conversation.id, update);
  save();
}

function authorized(req) {
  if (!accessKey) return true;
  const token = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('mono_session='))?.slice(13);
  const expires = sessions.get(token);
  if (expires && expires > Date.now()) return true;
  if (token) sessions.delete(token);
  return false;
}
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https: http:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'" });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) return res.status(403).json({ error: '请求来源不匹配' });
  next();
});
app.use(express.json({ limit: '1mb' }));
app.get('/api/auth', (req, res) => res.json({ authenticated: authorized(req), required: !!accessKey }));
app.post('/api/login', (req, res) => {
  const ip = req.socket.remoteAddress;
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.until > Date.now() && attempt.count >= 10) return res.status(429).json({ error: '尝试过于频繁，请稍后重试' });
  const value = Buffer.from(typeof req.body.key === 'string' ? req.body.key : '');
  const expected = Buffer.from(accessKey);
  if (accessKey && (value.length !== expected.length || !timingSafeEqual(value, expected))) {
    loginAttempts.set(ip, { count: attempt?.until > Date.now() ? attempt.count + 1 : 1, until: Date.now() + 60000 });
    return res.status(401).json({ error: '访问 key 不正确' });
  }
  loginAttempts.delete(ip);
  const token = randomBytes(32).toString('hex');
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  sessions.set(token, expires);
  res.setHeader('Set-Cookie', `mono_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ error: '请输入访问 key' });
  next();
});
app.use('/api', resources.observeRequests);
app.use('/api/resources', resources.router);
app.use('/api/usage-stats', usageStatsRouter({ codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') }));
app.get('/api/state', (req, res) => res.json(snapshot()));
app.use('/api', workspaceRouter({ state, defaultId: defaultWorkspaceId, save, broadcast }));
app.use('/api/conversations', mediaRouter({ state }));
app.use('/api/history', historyRouter({ codex, state, save, broadcast, models: () => models }));

async function refreshModels() {
  const available = [];
  let cursor;
  do {
    const result = await codex.call('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
    for (const m of result.data) available.push({ id: m.id, model: m.model, displayName: m.displayName,
      description: m.description, isDefault: m.isDefault, defaultReasoningEffort: m.defaultReasoningEffort,
      supportedReasoningEfforts: m.supportedReasoningEfforts, serviceTiers: m.serviceTiers || [],
      additionalSpeedTiers: m.additionalSpeedTiers || [], defaultServiceTier: m.defaultServiceTier });
    cursor = result.nextCursor;
  } while (cursor);
  models = available;
  modelsError = null;
  broadcast({ type: 'models', models, modelsError });
  return models;
}
app.get('/api/models', async (req, res) => res.json({ models: await refreshModels() }));

function threadSettings(c) {
  const permission = permissionFor(c.permissionMode);
  return { cwd: c.cwd || getWorkspace(state, c.workspaceId, defaultWorkspaceId).path, sandbox: permission.sandbox, approvalPolicy: permission.approvalPolicy, serviceTier: c.fast ? 'priority' : 'default',
    ...(c.model ? { model: c.model } : {}), ...(c.effort ? { config: { model_reasoning_effort: c.effort } } : {}) };
}

async function createConversation(options = {}) {
  if (codex.status !== 'ready') throw new Error('Codex 尚未就绪，请稍后重试');
  const settings = options.model ? validateSettings({}, options, models) : { permissionMode: 'workspace-write', fast: false, mode: 'default' };
  const selectedWorkspace = getWorkspace(state, options.workspaceId, defaultWorkspaceId);
  const result = await codex.call('thread/start', threadSettings({ ...settings, cwd: selectedWorkspace.path }));
  const conversation = { id: randomUUID(), threadId: result.thread.id, title: '新对话',
    model: result.model, effort: result.reasoningEffort, permissionMode: settings.permissionMode, fast: settings.fast, mode: settings.mode,
    workspaceId: selectedWorkspace.id, cwd: selectedWorkspace.path, createdAt: Date.now(), updatedAt: Date.now(), pinnedAt: null, archivedAt: null, turns: [], usage: null,
    status: 'idle', activeTurnId: null, attachments: {} };
  state.conversations.unshift(conversation);
  loaded.add(conversation.threadId);
  save(true);
  broadcast({ type: 'conversation', conversation });
  return conversation;
}
app.post('/api/conversations', async (req, res) => res.json(await createConversation(req.body)));
function getConversation(req) {
  const conversation = state.conversations.find(c => c.id === req.params.id);
  if (!conversation) throw Object.assign(new Error('对话不存在'), { status: 404 });
  return conversation;
}
app.patch('/api/conversations/:id', async (req, res) => {
  const c = getConversation(req);
  const { title, pinned, archived } = req.body;
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) return res.status(400).json({ error: '请输入对话名称' });
  if (pinned !== undefined && typeof pinned !== 'boolean' || archived !== undefined && typeof archived !== 'boolean') return res.status(400).json({ error: '对话状态无效' });
  if (pinned && (c.archivedAt || archived)) return res.status(409).json({ error: '请先恢复归档的对话' });
  if (archived !== undefined && (c.activeTurnId || c.status === 'active' || c.starting || c.archiving || c.actionBusy || c.goalBusy)) return res.status(409).json({ error: '请等待回复完成后再归档或恢复对话' });
  if (archived !== undefined && archived !== !!c.archivedAt) {
    c.archiving = true;
    try {
      // Empty threads have no native rollout to archive yet.
      if (archived && (c.turns.length || c.nativeHistory)) {
        await codex.call('thread/archive', { threadId: c.threadId });
        c.nativeArchived = true;
        loaded.delete(c.threadId);
      } else if (!archived && c.nativeArchived) {
        await codex.call('thread/unarchive', { threadId: c.threadId });
        c.nativeArchived = false;
      }
      c.archivedAt = archived ? Date.now() : null;
      if (archived) c.pinnedAt = null;
    } finally { delete c.archiving; }
  }
  if (title !== undefined) c.title = title.trim().slice(0, 100);
  if (pinned !== undefined) c.pinnedAt = pinned ? c.pinnedAt || Date.now() : null;
  save(true);
  publish(c);
  res.json(c);
});
app.patch('/api/conversations/:id/settings', (req, res) => {
  const c = getConversation(req);
  if (c.archivedAt) return res.status(409).json({ error: '请先恢复归档的对话' });
  if (c.status === 'active' || c.starting || c.actionBusy || c.goalBusy) return res.status(409).json({ error: '请等待回复完成后再切换配置' });
  const settings = validateSettings(c, req.body, models);
  Object.assign(c, settings);
  c.settingsCustomized = true;
  save(true);
  publish(c);
  res.json(c);
});
async function ensureLoaded(c, refresh = false) {
  if (!loaded.has(c.threadId) || refresh) {
    if (!c.turns.length && !c.nativeHistory && !c.goal) {
      const result = await codex.call('thread/start', threadSettings(c));
      loaded.delete(c.threadId);
      c.threadId = result.thread.id;
    } else await codex.call('thread/resume', { threadId: c.threadId, excludeTurns: true, ...threadSettings(c) });
    loaded.add(c.threadId);
  }
}
app.use('/api/conversations', goalsRouter({ codex, state, save, publish, ensureLoaded }));
app.use('/api/conversations', actionsRouter({ codex, state, save, publish, ensureLoaded, threadSettings, loaded }));
const startConversationTurn = createMessageSender({ codex, state, ensureLoaded, publish, uploadCleanup });
app.post('/api/conversations/:id/messages', async (req, res) => {
  res.json(await startConversationTurn(getConversation(req), req.body || {}));
});
app.post('/api/tasks', async (req, res) => {
  res.status(201).json(await startTask({ options: req.body || {}, codex, state, models, defaultWorkspaceId, loaded, save, broadcast, startTurn: startConversationTurn }));
});
app.post('/api/conversations/:id/interrupt', async (req, res) => {
  const c = getConversation(req);
  if (c.activeTurnId) await codex.call('turn/interrupt', { threadId: c.threadId, turnId: c.activeTurnId });
  res.json({ ok: true });
});
app.post('/api/approvals/:id', (req, res) => {
  const approval = approvals.get(req.params.id);
  if (!approval) return res.status(404).json({ error: '此请求已结束' });
  let result;
  if (approval.method === 'item/tool/requestUserInput') {
    if (!req.body.answers || typeof req.body.answers !== 'object') return res.status(400).json({ error: '请填写回答' });
    result = { answers: req.body.answers };
  } else if (approval.method === 'item/permissions/requestApproval') {
    result = { permissions: req.body.decision === 'accept' ? approval.params.permissions : {}, scope: 'turn' };
  } else if (approval.method === 'mcpServer/elicitation/request') {
    result = { action: req.body.decision === 'accept' ? 'accept' : 'decline', content: req.body.content || null };
  } else {
    if (!['accept', 'decline'].includes(req.body.decision)) return res.status(400).json({ error: '无效的操作' });
    result = { decision: req.body.decision };
  }
  codex.write({ id: approval.rpcId, result });
  approvals.delete(approval.id);
  broadcast({ type: 'approvals', approvals: [...approvals.values()] });
  res.json({ ok: true });
});

app.use('/api/uploads', uploadRouter({ uploadDir, uploads: state.uploads, save, touch: uploadCleanup.touch }));

const terminalService = terminalManager({ state, defaultWorkspaceId, terminals, broadcast });
app.use('/api/terminals', terminalDownloadsRouter({ terminals }));
app.use('/api/terminals', terminalService.router);
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
const staticDir = path.resolve(process.env.STATIC_DIR || path.join(root, 'dist'));
app.use(express.static(staticDir, { index: 'index.html' }));
app.get('/{*path}', (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
app.use((error, req, res, next) => {
  console.error(error.message);
  if (!res.headersSent) res.status(error.status || 500).json({ error: error.message || '服务器错误' });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !authorized(req) || !req.headers.origin || !sameOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', socket => {
  send(socket, snapshot());
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw);
      if (message.type === 'client/hello') { socket.conversationPatches = message.conversationPatches === true; return; }
      const t = terminals.get(message.id);
      if (!t || t.exited) return;
      if (message.type === 'terminal/input' && typeof message.data === 'string' && message.data.length <= 65536) {
        const input = (t.uploadInputTail || '') + message.data;
        uploadCleanup.markTextUsed(input);
        t.uploadInputTail = input.slice(-72);
        t.pty.write(message.data);
      }
      if (message.type === 'terminal/resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        t.cols = Math.max(10, Math.min(400, message.cols));
        t.rows = Math.max(3, Math.min(160, message.rows));
        t.pty.resize(t.cols, t.rows);
      }
    } catch { /* Ignore malformed websocket messages. */ }
  });
  socket.on('error', () => {});
});
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

codex.on('notification', ({ method, params }) => {
  const c = conversationByThread(params?.threadId);
  if (!c) return;
  if (method === 'thread/archived') { c.archivedAt ||= Date.now(); c.pinnedAt = null; c.nativeArchived = true; loaded.delete(c.threadId); }
  if (method === 'thread/unarchived') { c.archivedAt = null; c.nativeArchived = false; }
  if (method === 'turn/started' || method === 'turn/completed') c.updatedAt = Date.now();
  applyNotification(c, method, params);
  if (method === 'turn/completed') {
    for (const [id, a] of approvals) if (a.params.threadId === c.threadId) approvals.delete(id);
    broadcast({ type: 'approvals', approvals: [...approvals.values()] });
  }
  publish(c, { turnId: params.turnId || params.turn?.id });
});
codex.on('request', message => {
  if (!conversationByThread(message.params?.threadId)) {
    codex.write({ id: message.id, error: { code: -32601, message: '此客户端不支持该请求' } });
    return;
  }
  const approval = { id: randomUUID(), rpcId: message.id, method: message.method, params: message.params };
  approvals.set(approval.id, approval);
  broadcast({ type: 'approvals', approvals: [...approvals.values()] });
});
codex.on('status', status => {
  if (status === 'offline') {
    loaded.clear();
    approvals.clear();
    for (const c of state.conversations) {
      if (c.status === 'active') { c.status = 'idle'; c.activeTurnId = null; c.error = 'Codex 进程已断开，请重启服务后继续'; publish(c); }
    }
  }
  broadcast({ type: 'codex/status', status });
});

save(true);
uploadCleanup.start();
server.listen(port, host, () => console.log(`Mono Workspace listening on http://${host}:${port} · ${workspace}`));
try {
  await codex.start();
  try { await refreshModels(); }
  catch (error) { modelsError = '暂时无法读取模型列表，请重新获取'; console.error('模型列表读取失败:', error.message); }
} catch (error) { console.error('Codex 启动失败:', error.message); }

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  uploadCleanup.stop();
  save(true);
  clearInterval(heartbeat);
  for (const terminal of terminals.values()) terminal.pty.kill();
  codex.close();
  for (const socket of wss.clients) socket.close(1001, '服务正在重启');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
