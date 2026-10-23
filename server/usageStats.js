import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import express from 'express';

const DAY = 24 * 60 * 60 * 1000;
function localDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(entry => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function midnight(value) { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); }
function* daysBetween(from, to) { for (let value = midnight(from); value <= midnight(to); value += DAY) yield localDay(value); }
async function* rolloutFiles(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* rolloutFiles(filename);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield filename;
  }
}
const tokenTotal = info => info?.total_token_usage?.total_tokens;

export async function aggregateUsage({ codexHome, now = Date.now }) {
  const daily = new Map(), models = new Map();
  let totalTokens = 0, conversations = 0, completedTurns = 0, longestConversationMs = 0, latestActivity = 0;
  for (const directory of ['sessions', 'archived_sessions']) {
    for await (const filename of rolloutFiles(path.join(codexHome, directory))) {
      conversations++;
      let previousTotal = 0, currentModel = '未知模型', conversationStart = null, conversationEnd = 0, turnStart = null;
      let stream;
      try { stream = (await fs.open(filename, 'r')).createReadStream({ encoding: 'utf8' }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      stream.on('error', error => lines.emit('error', error));
      try {
        for await (const line of lines) {
          let record; try { record = JSON.parse(line); } catch { continue; }
          const timestamp = Date.parse(record.timestamp); if (!Number.isFinite(timestamp)) continue;
          const day = localDay(timestamp); latestActivity = Math.max(latestActivity, timestamp); conversationEnd = timestamp;
          conversationStart ??= timestamp;
          const payload = record.payload || {};
          if (record.type === 'turn_context') { currentModel = payload.model || currentModel; turnStart = timestamp; }
          if (record.type === 'event_msg' && payload.type === 'token_count') {
            const currentTotal = tokenTotal(payload.info);
            if (Number.isSafeInteger(currentTotal) && currentTotal >= previousTotal) {
              const delta = currentTotal - previousTotal;
              if (delta) {
                daily.set(day, (daily.get(day) || 0) + delta);
                models.set(currentModel, (models.get(currentModel) || 0) + delta);
                totalTokens += delta;
              }
              previousTotal = currentTotal;
            }
          }
          if (record.type === 'event_msg' && payload.type === 'task_complete') {
            completedTurns++;
            if (turnStart != null) longestConversationMs = Math.max(longestConversationMs, timestamp - turnStart);
            turnStart = null;
          }
        }
      } catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
      finally { lines.close(); stream.destroy(); }
      if (conversationStart != null) longestConversationMs = Math.max(longestConversationMs, Math.max(0, conversationEnd - conversationStart));
    }
  }
  const end = midnight(now()), start = end - 364 * DAY;
  const activity = [...daysBetween(start, end)].map(date => ({ date, tokens: daily.get(date) || 0 }));
  const entries = [...models].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens);
  let currentStreak = 0, longestStreak = 0, streak = 0;
  for (const day of [...daysBetween(start, end)]) {
    if ((daily.get(day) || 0) > 0) { streak++; longestStreak = Math.max(longestStreak, streak); } else streak = 0;
  }
  for (let i = activity.length - 1; i >= 0 && activity[i].tokens > 0; i--) currentStreak++;
  return { generatedAt: now(), totalTokens, peakDay: activity.reduce((peak, item) => item.tokens > peak.tokens ? item : peak, { date: null, tokens: 0 }),
    longestConversationMs, currentStreak, longestStreak, completedTurns, conversationCount: conversations,
    activity, models: entries, latestActivity };
}

export function usageStatsRouter({ codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), now = Date.now }) {
  const router = express.Router(); let cache, cachedAt = 0, pending;
  router.get('/', async (req, res) => {
    if (!req.query.refresh && cache && now() - cachedAt < 60000) return res.json(cache);
    pending ||= aggregateUsage({ codexHome, now }).then(value => { cache = value; cachedAt = now(); return value; }).finally(() => { pending = null; });
    try { res.json(await pending); } catch (error) { res.status(500).json({ error: '无法读取 Codex 使用历史，请稍后重试' }); }
  });
  return router;
}
