import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChartNoAxesColumnIncreasing, Flame, LoaderCircle, RefreshCw, Sparkles, TimerReset } from 'lucide-react';
import { Modal } from './Sidebar.jsx';
import { formatTokenCount } from '../shared/numberFormat.js';
import './usageStats.css';

const palette = ['#7aa2ff', '#a8bde8', '#587db9', '#8499b8', '#486087', '#c0cde2', '#65738f'];
function duration(value) {
  if (!value) return '0 分钟';
  const minutes = Math.round(value / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`;
  const days = Math.floor(hours / 24), remain = hours % 24;
  return `${days} 天${remain ? ` ${remain} 小时` : ''}`;
}
function formatDay(day, options = { month: 'numeric', day: 'numeric' }) { return new Intl.DateTimeFormat('zh-CN', options).format(new Date(`${day}T12:00:00`)); }

function Summary({ icon: Icon, label, value }) {
  return <div className="usage-stat-summary"><Icon size={15} /><strong>{value}</strong><span>{label}</span></div>;
}

function TokenTrend({ data }) {
  const entries = data.activity.slice(-8), max = Math.max(1, ...entries.map(entry => entry.tokens));
  const width = 900, height = 200, left = 12, right = 12, top = 12, bottom = 8;
  const x = index => left + index * (width - left - right) / Math.max(entries.length - 1, 1);
  const y = value => top + (max - value) / max * (height - top - bottom);
  const path = entries.map((entry, index) => `${index ? 'L' : 'M'}${x(index)} ${y(entry.tokens)}`).join(' ');
  return <section className="usage-stat-panel usage-trend-panel"><h3>每日 Token 趋势</h3><div className="usage-trend-legend"><i />Token 用量</div>
    <svg className="usage-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="最近八天 Token 用量趋势" preserveAspectRatio="none">
      {[0.25, 0.5, 0.75, 1].map(value => <line key={value} x1={left} x2={width - right} y1={y(max * value)} y2={y(max * value)} className="usage-trend-grid" />)}
      {entries.length > 1 && <path d={path} className="usage-trend-line" />}
      {entries.map((entry, index) => <g key={entry.date}><circle cx={x(index)} cy={y(entry.tokens)} r="3.5" className="usage-trend-point"><title>{formatDay(entry.date)} · {formatTokenCount(entry.tokens)} tokens</title></circle></g>)}
    </svg>
    <div className="usage-trend-dates" aria-hidden="true">{entries.map(entry => <span key={entry.date}>{formatDay(entry.date)}</span>)}</div>
  </section>;
}

function ModelUsage({ models, total }) {
  const data = models.map((model, index) => ({ ...model, color: palette[index % palette.length] }));
  let offset = 0;
  const segments = data.map(item => { const start = offset; const share = total ? item.tokens / total * 100 : 0; offset += share; return { ...item, start, share }; });
  return <section className="usage-stat-panel usage-model-panel"><h3>模型用量</h3><div className="usage-model-content"><svg viewBox="0 0 200 200" role="img" aria-label="不同模型 Token 占比" className="usage-model-donut">
    <circle cx="100" cy="100" r="73" className="usage-donut-track" />{segments.map(item => <circle key={item.model} cx="100" cy="100" r="73" className="usage-donut-segment" stroke={item.color} strokeDasharray={`${item.share * 4.586} ${458.6 - item.share * 4.586}`} strokeDashoffset={-item.start * 4.586} />)}
    <text x="100" y="94" textAnchor="middle" className="usage-donut-value">{formatTokenCount(total)}</text><text x="100" y="115" textAnchor="middle" className="usage-donut-unit">tokens</text>
  </svg><div className="usage-model-legend">{segments.map(item => <div key={item.model}><div><i style={{ background: item.color }} /><span title={item.model}>{item.model}</span><small>{formatTokenCount(item.tokens)} tokens</small></div><b>{item.share.toFixed(1).replace(/\.0$/, '')}%</b></div>)}{!segments.length && <span className="usage-stat-empty">暂无模型数据</span>}</div></div></section>;
}

function ActivityGrid({ data }) {
  const [mode, setMode] = useState('day');
  const grid = useRef(null);
  const cells = useMemo(() => {
    if (mode === 'day') return data.activity.map(item => ({ ...item, label: formatDay(item.date, { year: 'numeric', month: 'long', day: 'numeric' }) }));
    if (mode === 'week') {
      const groups = [];
      for (let index = 0; index < data.activity.length; index += 7) {
        const chunk = data.activity.slice(index, index + 7);
        groups.push({ date: chunk[0].date, tokens: chunk.reduce((sum, item) => sum + item.tokens, 0), label: `${formatDay(chunk[0].date)} 起` });
      }
      return groups;
    }
    const groups = new Map();
    for (const item of data.activity) { const month = item.date.slice(0, 7); const entry = groups.get(month) || { date: `${month}-01`, tokens: 0, label: month.replace('-', '年') + '月' }; entry.tokens += item.tokens; groups.set(month, entry); }
    return [...groups.values()];
  }, [data.activity, mode]);
  useEffect(() => { if (grid.current) grid.current.scrollLeft = mode === 'day' ? grid.current.scrollWidth : 0; }, [mode, cells.length]);
  const max = Math.max(1, ...cells.map(cell => cell.tokens));
  return <section className="usage-stat-panel usage-activity-panel"><header><h3>Token 活动</h3><div role="group" aria-label="活动统计周期">{[['day', '每日'], ['week', '每周'], ['total', '累计']].map(([id, label]) => <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>)}</div></header>
    <div ref={grid} className={`usage-activity-grid mode-${mode}`} role="list" aria-label="Token 活动日历">{cells.map(cell => <span key={cell.date} role="listitem" title={`${cell.label} · ${formatTokenCount(cell.tokens)} tokens`} className={cell.tokens ? `usage-activity-level-${Math.min(4, Math.ceil(cell.tokens / max * 4))}` : ''} />)}</div>
    {mode === 'day' && <div className="usage-activity-months">{[...new Set(data.activity.map(item => item.date.slice(0, 7)))].map(month => <span key={month}>{formatDay(`${month}-01`, { month: 'numeric' })}</span>)}</div>}
  </section>;
}

export default function UsageStats({ onClose }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load(refresh = false) {
    setBusy(true); setError('');
    try { const response = await fetch(`/api/usage-stats${refresh ? '?refresh=1' : ''}`); const result = await response.json(); if (!response.ok) throw new Error(result.error || '读取统计失败'); setData(result); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []);
  return <Modal title="使用统计" onClose={onClose} className="usage-stats-modal">
    <div className="usage-stats-toolbar"><span>Codex 本机历史 · 按 Token 记录统计</span><button type="button" onClick={() => load(true)} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} />刷新</button></div>
    <div className="usage-stats-body" aria-busy={busy && !data}>
      {error && <div role="alert" className="resource-error">{error}<button type="button" onClick={() => load(true)}>重试</button></div>}
      {!data && busy && <div className="resource-loading"><LoaderCircle size={20} className="spin" />正在汇总本机 Token 历史…</div>}
      {data && <><div className="usage-stat-summary-row"><Summary icon={Sparkles} label="累计 Token 数" value={formatTokenCount(data.totalTokens)} /><Summary icon={ChartNoAxesColumnIncreasing} label="峰值 Token 数" value={formatTokenCount(data.peakDay.tokens)} /><Summary icon={TimerReset} label="最长聊天时长" value={duration(data.longestConversationMs)} /><Summary icon={Flame} label="当前连续天数" value={`${data.currentStreak} 天`} /><Summary icon={CalendarDays} label="最长连续天数" value={`${data.longestStreak} 天`} /></div>
        <ActivityGrid data={data} /><TokenTrend data={data} /><ModelUsage models={data.models} total={data.totalTokens} />
        <p className="usage-stats-footnote">统计本机 Codex 会话历史的 Token 记录，包含网页与 CLI 会话。读取于 {new Date(data.generatedAt).toLocaleString('zh-CN')}</p>
      </>}
    </div>
  </Modal>;
}
