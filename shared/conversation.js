// The app-server is authoritative; keep its items, deltas, and usage intact.
export function applyNotification(conversation, method, params) {
  if (method === 'thread/goal/updated') { conversation.goal = params.goal; return; }
  if (method === 'thread/goal/cleared') { conversation.goal = null; return; }
  if (method === 'thread/tokenUsage/updated') {
    conversation.usage = params.tokenUsage;
    return;
  }
  if (method === 'thread/name/updated') {
    if (params.threadName) conversation.title = params.threadName;
    return;
  }
  if (method === 'thread/status/changed') {
    conversation.status = params.status.type;
    return;
  }
  if (method === 'error') {
    conversation.error = params.error?.message || 'Codex 请求失败';
    return;
  }
  if (!params.turnId && !params.turn) return;
  const turnId = params.turnId || params.turn.id;
  let turn = conversation.turns.find(t => t.id === turnId);
  if (!turn) {
    turn = { id: turnId, status: 'inProgress', items: [] };
    conversation.turns.push(turn);
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    const items = turn.items;
    Object.assign(turn, params.turn);
    // Paginated history can return only a final item, or no items at all.
    // Merge by ID so a completion never discards the user's message or tools.
    turn.items = items;
    for (const item of params.turn.items || []) {
      const index = items.findIndex(i => i.id === item.id);
      if (index < 0) items.push(item);
      else items[index] = item;
    }
    conversation.status = method === 'turn/started' ? 'active' : 'idle';
    conversation.activeTurnId = method === 'turn/started' ? turn.id : null;
    if (turn.error) conversation.error = turn.error.message;
    return;
  }
  if (method === 'turn/plan/updated') {
    turn.plan = params.plan;
    return;
  }
  if (params.item) {
    const index = turn.items.findIndex(i => i.id === params.item.id);
    if (index < 0) turn.items.push(params.item);
    else turn.items[index] = params.item;
    return;
  }
  let item = turn.items.find(i => i.id === params.itemId);
  if (!item && method === 'item/agentMessage/delta') {
    item = { id: params.itemId, type: 'agentMessage', text: '' };
    turn.items.push(item);
  }
  if (!item) return;
  if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
    item.text = (item.text || '') + params.delta;
  } else if (method === 'item/commandExecution/outputDelta') {
    item.aggregatedOutput = (item.aggregatedOutput || '') + params.delta;
  } else if (method === 'item/reasoning/summaryTextDelta') {
    item.summary ||= [];
    const index = params.summaryIndex || 0;
    item.summary[index] = (item.summary[index] || '') + params.delta;
  }
}

export function usageMetrics(usage) {
  const capacity = usage?.modelContextWindow;
  const used = usage?.last?.totalTokens;
  const input = usage?.total?.inputTokens, cached = usage?.total?.cachedInputTokens;
  const uncached = (input, cached) => input != null && cached != null ? Math.max(0, input - cached) : null;
  return {
    total: usage?.total?.totalTokens ?? null,
    input: usage?.total?.inputTokens ?? null,
    output: usage?.total?.outputTokens ?? null,
    cached: usage?.total?.cachedInputTokens ?? null,
    reasoning: usage?.total?.reasoningOutputTokens ?? null,
    uncached: uncached(input, cached),
    cacheHit: input > 0 && cached != null ? Math.min(100, Math.max(0, cached / input * 100)) : input === 0 && cached === 0 ? 0 : null,
    context: { cached: usage?.last?.cachedInputTokens ?? null,
      uncached: uncached(usage?.last?.inputTokens, usage?.last?.cachedInputTokens), output: usage?.last?.outputTokens ?? null },
    capacity: capacity > 0 ? capacity : null,
    used: used ?? null,
    percent: capacity > 0 && used != null ? Math.min(100, Math.max(0, used / capacity * 100)) : null,
  };
}
