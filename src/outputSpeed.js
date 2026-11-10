const outputCount = conversation => {
  const value = conversation.usage?.total?.outputTokens;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const activeTurn = conversation => conversation.activeTurnId
  || [...(conversation.turns || [])].reverse().find(turn => turn.status === 'inProgress')?.id || null;

// Measure only token increments seen by this browser. Old cumulative usage is
// a baseline, never output generated during this observation.
export class OutputSpeedTracker {
  records = new Map();
  constructor(storage = null) {
    this.storage = storage; this.saved = new Map();
    try { this.saved = new Map(JSON.parse(storage?.getItem('mono-output-speeds') || '[]')); } catch { /* Storage may be unavailable. */ }
  }
  restore(conversation, total) {
    const saved = this.saved.get(conversation.id), result = saved?.result;
    if (saved?.outputTotal !== total || saved?.turnId !== conversation.turns?.at(-1)?.id) return null;
    return result && Number.isFinite(result.tokensPerSecond) && result.tokensPerSecond > 0 && result.tokens > 0 && result.elapsedMs > 0 ? result : null;
  }
  remember(conversation, record, total) {
    if (!record.result || record.run?.end == null || total == null) return;
    const turnId = conversation.turns?.at(-1)?.id;
    if (!turnId || record.run.turnId && record.run.turnId !== turnId) return;
    const saved = { turnId, outputTotal: total, result: record.result };
    if (JSON.stringify(this.saved.get(conversation.id)) === JSON.stringify(saved)) return;
    this.saved.delete(conversation.id); this.saved.set(conversation.id, saved);
    while (this.saved.size > 50) this.saved.delete(this.saved.keys().next().value);
    try { this.storage?.setItem('mono-output-speeds', JSON.stringify([...this.saved])); } catch { /* Continue without persistence. */ }
  }
  startExisting(conversation, now) {
    const total = outputCount(conversation);
    this.records.set(conversation.id, { lastTotal: total, run: { start: now, baseline: total, turnId: null, partial: total == null, end: null }, result: null });
    return { ...conversation, outputSpeed: null };
  }
  startNew(conversation, now) {
    this.records.set(conversation.id, { lastTotal: 0, run: { start: now, baseline: 0, turnId: activeTurn(conversation), partial: false, end: null }, result: null });
    return this.observe(conversation, now);
  }
  observe(conversation, now, snapshot = false) {
    const total = outputCount(conversation), turnId = activeTurn(conversation);
    const active = conversation.status === 'active' || !!turnId;
    let record = this.records.get(conversation.id);
    if (!record) {
      record = { lastTotal: total, run: null, result: null };
      this.records.set(conversation.id, record);
      snapshot = true;
    }
    if (snapshot) {
      if (active || record.run && record.run.end == null || total !== record.lastTotal) record.result = null;
      record.run = active ? { start: now, baseline: total, turnId, partial: true, end: null } : null;
      record.lastTotal = total;
      // A reconnect must not include unobserved tokens or disconnected time.
      if (!active && !record.result) record.result = this.restore(conversation, total);
    } else {
      const run = record.run;
      if (active && (!run || run.end != null || turnId && run.turnId && turnId !== run.turnId)) {
        record.run = { start: now, baseline: record.lastTotal ?? total, turnId, partial: record.lastTotal == null, end: null };
        record.result = null;
      }
      if (record.run) {
        const run = record.run;
        run.turnId ||= turnId;
        if (total != null && (run.baseline == null || record.lastTotal != null && total < record.lastTotal)) {
          run.start = now; run.baseline = total; run.partial = true;
          record.result = null;
        }
        if (!active && run.end == null) run.end = now;
        const elapsedMs = (run.end ?? now) - run.start;
        const tokens = total == null || run.baseline == null ? 0 : total - run.baseline;
        if (tokens > 0 && elapsedMs > 0) {
          record.result = { tokensPerSecond: tokens * 1000 / elapsedMs, tokens, elapsedMs, partial: run.partial };
        }
      }
      if (total != null) record.lastTotal = total;
      this.remember(conversation, record, total);
    }
    return { ...conversation, outputSpeed: record.result };
  }
}
