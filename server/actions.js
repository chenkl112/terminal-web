import express from 'express';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allPages } from './history.js';
const run = promisify(execFile);

export function actionsRouter({ codex, state, save, publish, ensureLoaded, threadSettings, loaded }) {
  const router = express.Router();
  router.post('/:id/actions', async (req, res) => {
    const c = state.conversations.find(item => item.id === req.params.id);
    if (!c) return res.status(404).json({ error: '对话不存在' });
    const { action, argument = '' } = req.body || {};
    if (typeof argument !== 'string' || !['compact', 'fork', 'review', 'diff', 'skills'].includes(action)) return res.status(400).json({ error: '不支持的命令' });
    if (action === 'skills') return res.json(await codex.call('skills/list', { cwds: [c.cwd] }));
    if (action === 'diff') {
      try {
        const options = { maxBuffer: 4 * 1024 * 1024, timeout: 10000 };
        const { stdout } = await run('git', ['-C', c.cwd, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], options);
        return res.json({ diff: stdout || '已跟踪文件没有未提交的改动。' });
      } catch (error) {
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return res.status(413).json({ error: '差异超过 4 MB，请在终端中查看完整 diff。' });
        return res.status(400).json({ error: '当前工作区没有可比较的 Git 提交。' });
      }
    }
    if (c.archivedAt) return res.status(409).json({ error: '请先恢复归档的对话' });
    if (c.status === 'active' || c.activeTurnId || c.starting || c.actionBusy || c.archiving || c.goalBusy) return res.status(409).json({ error: '请等待当前操作完成' });
    if (action !== 'review' && !c.turns.length) return res.status(409).json({ error: '发送消息后才能执行此命令' });
    c.actionBusy = true;
    try {
      await ensureLoaded(c, true);
      if (action === 'compact') {
        await codex.call('thread/compact/start', { threadId: c.threadId });
        return res.json({ ok: true, message: '已开始压缩上下文' });
      }
      if (action === 'review') {
        const result = await codex.call('review/start', { threadId: c.threadId, delivery: 'inline', target: argument.trim() ? { type: 'custom', instructions: argument.trim() } : { type: 'uncommittedChanges' } });
        c.activeTurnId = result.turn.id; c.status = 'active';
        return res.json({ ok: true, turnId: result.turn.id });
      }
      const result = await codex.call('thread/fork', { threadId: c.threadId, excludeTurns: true, ...threadSettings(c) });
      const turns = await allPages((method, params) => codex.call(method, params), 'thread/turns/list', { threadId: result.thread.id, limit: 50, sortDirection: 'asc', itemsView: 'full' });
      for (const turn of turns) if (turn.itemsView && turn.itemsView !== 'full') turn.items = await allPages((method, params) => codex.call(method, params), 'thread/items/list', { threadId: result.thread.id, turnId: turn.id, limit: 100, sortDirection: 'asc' });
      const fork = { ...c, id: randomUUID(), threadId: result.thread.id, title: `${c.title} · 分支`.slice(0, 100), turns,
        createdAt: Date.now(), updatedAt: Date.now(), pinnedAt: null, archivedAt: null, nativeArchived: false, nativeHistory: false,
        attachments: structuredClone(c.attachments || {}), status: 'idle', activeTurnId: null, actionBusy: false, error: null };
      state.conversations.unshift(fork); loaded.add(fork.threadId); save(true); publish(fork);
      return res.json({ conversation: fork });
    } finally { delete c.actionBusy; save(true); publish(c); }
  });
  return router;
}
