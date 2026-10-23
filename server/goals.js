import express from 'express';

export function goalsRouter({ codex, state, save, publish, ensureLoaded }) {
  const router = express.Router();
  const find = (req, res) => {
    const c = state.conversations.find(item => item.id === req.params.id);
    if (!c) res.status(404).json({ error: '对话不存在' });
    return c;
  };
  const remember = (c, goal) => { c.goal = goal || null; save(true); publish(c); return { goal: c.goal }; };
  router.get('/:id/goal', async (req, res) => {
    const c = find(req, res); if (!c) return;
    try { res.json(remember(c, (await codex.call('thread/goal/get', { threadId: c.threadId })).goal)); }
    catch (error) {
      if (!c.turns.length && !c.goal && /not found|not loaded|unknown thread|no rollout|unable to find/i.test(error.message)) return res.json({ goal: null });
      throw error;
    }
  });
  router.post('/:id/goal', async (req, res) => {
    const c = find(req, res); if (!c) return;
    const { operation, objective, tokenBudget } = req.body || {};
    if (!['create', 'pause', 'resume', 'clear', 'budget'].includes(operation)) return res.status(400).json({ error: '目标操作无效' });
    if (c.archivedAt) return res.status(409).json({ error: '请先恢复归档的对话' });
    if (c.goalBusy || c.starting || c.actionBusy || c.archiving) return res.status(409).json({ error: '请等待当前操作完成' });
    if (['create', 'resume'].includes(operation) && (c.status === 'active' || c.activeTurnId)) return res.status(409).json({ error: '请等待当前回复结束，或先停止生成' });
    if (operation === 'create' && (typeof objective !== 'string' || !objective.trim() || objective.length > 20000)) return res.status(400).json({ error: '请输入目标，最多 20,000 字符' });
    if (tokenBudget !== undefined && tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) return res.status(400).json({ error: 'Token 预算必须是正整数，留空表示不限' });
    c.goalBusy = true;
    try {
      let current;
      try { current = (await codex.call('thread/goal/get', { threadId: c.threadId })).goal; }
      catch (error) {
        if (operation === 'create' && !c.turns.length && !c.goal && /not found|not loaded|unknown thread|no rollout|unable to find/i.test(error.message)) current = null;
        else throw error;
      }
      if (operation === 'create' && current && current.status !== 'complete') return res.status(409).json({ error: '已有未完成的目标，请继续原目标，或先清除它' });
      if (operation !== 'create' && !current) return res.status(409).json({ error: '当前对话没有目标' });
      if (operation === 'resume' && current.status === 'complete') return res.status(409).json({ error: '目标已经完成，请创建新目标' });
      // Activation refreshes model/Fast settings. Pausing and clearing must not resume work.
      if (operation === 'create' || operation === 'resume') await ensureLoaded(c, true);
      let goal;
      if (operation === 'clear') { await codex.call('thread/goal/clear', { threadId: c.threadId, origin: 'user' }); goal = null; }
      else {
        const params = { threadId: c.threadId, origin: 'user' };
        if (operation === 'create') Object.assign(params, { objective: objective.trim(), status: 'active', tokenBudget: tokenBudget ?? null });
        if (operation === 'pause' || operation === 'resume') params.status = operation === 'pause' ? 'paused' : 'active';
        if (operation === 'budget') params.tokenBudget = tokenBudget ?? null;
        goal = (await codex.call('thread/goal/set', params)).goal;
      }
      remember(c, goal);
      if ((operation === 'pause' || operation === 'clear' && current?.status === 'active') && c.activeTurnId) {
        try { await codex.call('turn/interrupt', { threadId: c.threadId, turnId: c.activeTurnId }); }
        catch (error) { if (!/not found|no active|already.*completed|not in progress/i.test(error.message)) throw error; }
      }
      return res.json({ goal: c.goal });
    } finally { delete c.goalBusy; save(true); publish(c); }
  });
  return router;
}
