import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export async function allPages(call, method, params) {
  const items = [], seen = new Set();
  let cursor;
  do {
    const page = await call(method, { ...params, ...(cursor ? { cursor } : {}) });
    items.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('历史会话分页异常，请重新加载');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

export async function nativeDetails(filePath) {
  let context, usage;
  if (!filePath) return {};
  let file;
  try { file = await fs.promises.open(filePath, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const stream = file.createReadStream({ encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  stream.on('error', error => lines.emit('error', error));
  try {
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'turn_context') context = record.payload;
      if (record.type === 'event_msg' && record.payload?.type === 'token_count' && record.payload.info) usage = record.payload.info;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { lines.close(); stream.destroy(); }
  const tokenFields = value => value && ({ totalTokens: value.total_tokens, inputTokens: value.input_tokens,
    outputTokens: value.output_tokens, cachedInputTokens: value.cached_input_tokens, reasoningOutputTokens: value.reasoning_output_tokens });
  const policy = context?.sandbox_policy?.type;
  return { ...(context?.model ? { model: context.model } : {}), ...(context?.effort ? { effort: context.effort } : {}),
    fast: context?.service_tier === 'priority',
    permissionMode: policy === 'danger-full-access' ? 'full-access' : policy === 'workspace-write' ? 'workspace-write' : 'read-only',
    ...(usage ? { usage: { total: tokenFields(usage.total_token_usage), last: tokenFields(usage.last_token_usage), modelContextWindow: usage.model_context_window } } : {}) };
}

export function historyRouter({ codex, state, save, broadcast, models }) {
  const router = express.Router();
  const call = (method, params) => codex.call(method, params);
  const snapshots = new Map();
  const openings = new Map();
  let cached, pending, cacheTime = 0;
  async function nativeList(refresh) {
    if (!refresh && cached && Date.now() - cacheTime < 20000) return cached;
    if (pending) return pending;
    pending = Promise.all([false, true].map(async archived => {
      const threads = await allPages(call, 'thread/list', { archived, modelProviders: [], limit: 100, sortKey: 'updated_at' });
      return threads.map(thread => ({ ...thread, archived }));
    })).then(groups => { cached = groups.flat(); cacheTime = Date.now(); return cached; }).finally(() => { pending = null; });
    return pending;
  }
  function describe(c) {
    return { key: c.id, threadId: c.threadId, title: c.title, cwd: c.cwd, workspaceName: state.workspaces.find(w => w.id === c.workspaceId)?.name || path.basename(c.cwd || ''),
      updatedAt: c.updatedAt || c.createdAt, createdAt: c.createdAt, archived: !!c.archivedAt, source: c.nativeHistory ? 'codex' : 'web' };
  }
  router.get('/', async (req, res) => {
    const limit = 40;
    let snapshot, offset = 0;
    if (req.query.cursor) {
      const [id, value] = String(req.query.cursor).split(':');
      snapshot = snapshots.get(id); offset = Number(value);
      if (!snapshot || snapshot.expires < Date.now() || !Number.isSafeInteger(offset) || offset < 0) return res.status(409).json({ error: '历史列表已更新，请点击刷新' });
    } else {
      let threads = [], warning = null;
      try { threads = await nativeList(req.query.refresh === '1'); }
      catch { warning = '暂时无法读取本机 Codex 历史，点击刷新重试。'; }
      const items = new Map(state.conversations.map(c => [c.threadId, describe(c)]));
      for (const thread of threads) {
        const local = state.conversations.find(c => c.threadId === thread.id);
        const existing = local && describe(local);
        items.set(thread.id, { key: existing?.key || thread.id, threadId: thread.id,
          title: existing?.title || thread.name || thread.preview?.split('\n')[0]?.slice(0, 100) || '未命名对话',
          cwd: thread.cwd, workspaceName: existing?.workspaceName || path.basename(thread.cwd) || thread.cwd,
          createdAt: thread.createdAt * 1000, updatedAt: Math.max(existing?.updatedAt || 0, thread.updatedAt * 1000),
          archived: existing ? existing.archived : thread.archived, source: existing?.source || 'codex' });
      }
      const query = String(req.query.q || '').trim().toLowerCase();
      const archived = req.query.archived || 'all';
      const cwd = String(req.query.cwd || '');
      const all = [...items.values()];
      const workspaces = [...new Set(all.map(item => item.cwd).filter(Boolean))].sort();
      const filtered = all.filter(item => (!query || `${item.title} ${item.cwd}`.toLowerCase().includes(query))
        && (archived === 'all' || item.archived === (archived === 'true')) && (!cwd || item.cwd === cwd))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
      snapshot = { id: randomUUID(), items: filtered, workspaces, warning, expires: Date.now() + 5 * 60000 };
      for (const [id, old] of snapshots) if (old.expires < Date.now()) snapshots.delete(id);
      if (snapshots.size >= 30) snapshots.delete(snapshots.keys().next().value);
      snapshots.set(snapshot.id, snapshot);
    }
    res.json({ items: snapshot.items.slice(offset, offset + limit), total: snapshot.items.length,
      nextCursor: offset + limit < snapshot.items.length ? `${snapshot.id}:${offset + limit}` : null,
      workspaces: snapshot.workspaces, warning: snapshot.warning });
  });
  router.post('/open', async (req, res) => {
    const { key } = req.body || {};
    if (typeof key !== 'string' || !/^[a-f0-9-]{36}$/i.test(key)) return res.status(400).json({ error: '会话标识无效' });
    const existing = state.conversations.find(c => c.id === key || c.threadId === key);
    if (existing && (!existing.nativeHistory || Date.now() - (existing.historyLoadedAt || 0) < 2000)) return res.json({ conversation: existing, workspace: state.workspaces.find(w => w.id === existing.workspaceId) });
    const threadId = existing?.threadId || key;
    if (!openings.has(threadId)) openings.set(threadId, (async () => {
      const { thread } = await call('thread/read', { threadId, includeTurns: false });
      const turns = await allPages(call, 'thread/turns/list', { threadId, limit: 50, sortDirection: 'asc', itemsView: 'full' });
      for (const turn of turns) if (turn.itemsView && turn.itemsView !== 'full') {
        turn.items = await allPages(call, 'thread/items/list', { threadId, turnId: turn.id, limit: 100, sortDirection: 'asc' });
        turn.itemsView = 'full';
      }
      const details = await nativeDetails(thread.path);
      let goal = existing?.goal || null;
      try { goal = (await call('thread/goal/get', { threadId })).goal || null; } catch { /* Older servers may not expose goals. */ }
      let workspace = state.workspaces.find(w => w.path === thread.cwd);
      if (!workspace) { workspace = { id: randomUUID(), name: path.basename(thread.cwd) || thread.cwd, path: thread.cwd, createdAt: Date.now() }; state.workspaces.push(workspace); }
      const selected = models().find(model => model.isDefault) || models()[0];
      const archived = (await nativeList(!!existing)).some(item => item.id === threadId && item.archived);
      const conversation = { ...existing, id: existing?.id || threadId, threadId, title: existing?.title || thread.name || thread.preview?.split('\n')[0]?.slice(0, 100) || '未命名对话',
        workspaceId: workspace.id, cwd: thread.cwd, createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000,
        model: selected?.model, effort: selected?.defaultReasoningEffort, usage: null, ...details,
        ...(existing?.settingsCustomized ? { model: existing.model, effort: existing.effort, permissionMode: existing.permissionMode, fast: !!existing.fast, mode: existing.mode || 'default' } : {}),
        turns, goal, attachments: existing?.attachments || {}, status: existing?.status || 'idle', activeTurnId: existing?.activeTurnId || null, pinnedAt: existing?.pinnedAt || null,
        nativeHistory: true, historyLoadedAt: Date.now(), nativeArchived: archived, archivedAt: archived ? existing?.archivedAt || thread.updatedAt * 1000 : null };
      if (existing) Object.assign(existing, conversation); else state.conversations.unshift(conversation);
      save(true);
      broadcast({ type: 'workspaces', workspaces: state.workspaces });
      broadcast({ type: 'conversation', conversation });
      return { conversation, workspace };
    })().finally(() => openings.delete(threadId)));
    res.json(await openings.get(threadId));
  });
  return router;
}
