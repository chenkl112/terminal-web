export const sessionToolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'imageGeneration']);
const duration = value => Number.isFinite(value) && value >= 0 ? value : null;
const outputLength = turn => (turn?.items || []).reduce((sum, item) => sum + (item.type === 'agentMessage' ? item.text?.length || 0
  : item.type === 'reasoning' ? (item.summary || []).reduce((n, text) => n + text.length, 0) : 0), 0);

export function sessionDuration(value) {
  if (value == null) return '—';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分${seconds % 60}秒`;
}

export class SessionStatsTracker {
  records = new Map();
  request(conversation, start) {
    const record = this.records.get(conversation.id) || { observations: new Map(), current: null, idleSeen: true };
    record.pendingStart = start; this.records.set(conversation.id, record);
  }
  observe(conversation, now, snapshot = false) {
    let record = this.records.get(conversation.id);
    if (!record) { record = { observations: new Map(), current: null, idleSeen: false }; this.records.set(conversation.id, record); }
    const turns = conversation.turns || [];
    const activeId = conversation.activeTurnId || [...turns].reverse().find(turn => turn.status === 'inProgress')?.id;
    const active = conversation.status === 'active' || !!activeId;
    const turn = active ? turns.find(item => item.id === activeId)
      : turns.find(item => item.id === record.current?.turnId) || turns.at(-1);
    if (snapshot) {
      if (record.current) record.current.partial = true;
      record.current = null; record.idleSeen = !active; record.pendingStart = null;
    }
    if (active && (!record.current || activeId && record.current.turnId && activeId !== record.current.turnId)) {
      const observation = { turnId: activeId, start: record.pendingStart ?? now, last: record.pendingStart ?? now, modelMs: 0,
        tools: new Map(), runningTools: [], ttftMs: null, partial: snapshot || !record.idleSeen };
      record.observations.set(activeId || Symbol('turn'), observation); record.current = observation; record.pendingStart = null;
      record.idleSeen = false;
    }
    const current = record.current;
    if (current) {
      if (!current.turnId && activeId) {
        for (const [key, entry] of record.observations) if (entry === current) record.observations.delete(key);
        current.turnId = activeId; record.observations.set(activeId, current);
      }
      const elapsed = Math.max(0, now - current.last);
      if (!current.runningTools.length) current.modelMs += elapsed;
      for (const id of current.runningTools) current.tools.set(id, (current.tools.get(id) || 0) + elapsed);
      current.last = now;
      current.runningTools = (turn?.items || []).filter(item => sessionToolTypes.has(item.type) && item.status === 'inProgress').map(item => item.id);
      if (!current.partial && current.ttftMs == null && outputLength(turn) > 0) current.ttftMs = Math.max(0, now - current.start);
      if (!active) { record.current = null; record.idleSeen = true; record.pendingStart = null; }
    } else if (!active) record.idleSeen = true;
    return { ...conversation, sessionStats: this.summary(conversation) };
  }
  summary(conversation) {
    const observations = [...(this.records.get(conversation.id)?.observations.values() || [])];
    const turns = conversation.turns || [], tools = turns.flatMap(turn => (turn.items || []).filter(item => sessionToolTypes.has(item.type)).map(item => ({ turnId: turn.id, item })));
    let toolMs = 0, knownTools = 0;
    for (const { turnId, item } of tools) {
      const observed = observations.find(entry => entry.turnId === turnId)?.tools.get(item.id);
      const time = duration(item.durationMs) ?? observed;
      if (time != null) { toolMs += time; knownTools++; }
    }
    const firstTokens = observations.map(entry => entry.ttftMs).filter(value => value != null);
    return { rounds: turns.length, steps: tools.length,
      modelMs: observations.length ? observations.reduce((sum, entry) => sum + entry.modelMs, 0) : null,
      toolMs: tools.length && !knownTools ? null : toolMs,
      ttftMs: firstTokens.length ? firstTokens.reduce((sum, value) => sum + value, 0) / firstTokens.length : null,
      partial: observations.some(entry => entry.partial) || knownTools < tools.length };
  }
}
