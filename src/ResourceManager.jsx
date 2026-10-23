import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Cpu, HardDrive, LoaderCircle, MemoryStick, Network, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Modal } from './Sidebar.jsx';

const tabs = [{ id: 'cpu', label: 'CPU', icon: Cpu }, { id: 'memory', label: '内存', icon: MemoryStick }, { id: 'storage', label: '存储', icon: HardDrive }, { id: 'network', label: '网络', icon: Network }];
const bytes = value => {
  if (value == null) return '—';
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'], unit = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
};
const percent = value => value == null ? '—' : `${value.toFixed(1)}%`;
const width = value => `${Math.max(0, Math.min(100, value || 0))}%`;
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
async function request(route, signal, method = 'GET') {
  const response = await fetch(`/api/resources${route}`, { method, signal });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '读取资源信息失败'); return data;
}

function UsageCard({ label, value, system, appPercent, systemPercent, note, icon: Icon }) {
  return <section className="resource-usage-card"><div className="resource-card-label"><Icon size={16} />{label}</div><div className="resource-big-number">{value}<span>Codex 工作区</span></div>
    <div className="resource-usage-track" role="progressbar" aria-label={`${label}占用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={appPercent == null ? undefined : Math.min(100, Math.max(0, appPercent))}>
      <span className="resource-system-fill" style={{ width: width(systemPercent) }} /><span className="resource-app-fill" style={{ width: width(appPercent) }} />
    </div><div className="resource-legend"><span><i className="resource-app-dot" />Codex 工作区</span><span><i className="resource-system-dot" />整机 <b>{system}</b></span></div><p>{note}</p>
  </section>;
}

function Processes({ metrics, tab }) {
  const memory = tab === 'memory';
  return <>{metrics?.groups.map(group => <details key={group.id} className="resource-process-group" open><summary><ChevronDown size={15} /><strong>{group.label}</strong><span className="resource-count">{group.processes.length}</span><b>{memory ? bytes(group.processes.reduce((sum, item) => sum + item.rss, 0)) : percent(group.processes.some(item => item.cpuPercent != null) ? group.processes.reduce((sum, item) => sum + (item.cpuPercent || 0), 0) : null)}</b></summary>
    <table><thead><tr><th>进程</th><th>PID</th><th>{memory ? '内存' : 'CPU'}</th></tr></thead><tbody>{[...group.processes].sort((a, b) => memory ? b.rss - a.rss : (b.cpuPercent || 0) - (a.cpuPercent || 0)).map(item => <tr key={item.pid}><td title={item.command}>{item.name}</td><td>{item.pid}</td><td>{memory ? bytes(item.rss) : percent(item.cpuPercent)}</td></tr>)}</tbody></table>
  </details>)}</>;
}

function Storage({ data, busy, error, onRecalculate }) {
  return <><div className="resource-storage-heading"><div><span>应用总占用</span><strong>{data ? bytes(data.total) : '—'}</strong></div><small>{data ? `上次计算 ${time(data.timestamp)}` : '正在统计本机文件…'}</small><button type="button" disabled={busy} onClick={onRecalculate}><RefreshCw size={14} className={busy ? 'spin' : ''} />{busy ? '计算中…' : '重新计算'}</button></div>
    {error && <div role="alert" className="resource-error">{error}</div>}
    {busy && !data && <div className="resource-loading"><LoaderCircle size={20} className="spin" />正在计算存储占用…</div>}
    {data?.disks.map(disk => <section className="resource-disk-card" key={disk.dev}><h3><HardDrive size={18} /><span title={disk.path}>{disk.path}</span></h3>
      <div className="resource-storage-bar" role="img" aria-label="应用存储分类">{disk.categories.filter(category => category.bytes > 0).map(category => <span key={category.id} style={{ width: width(disk.appBytes ? category.bytes / disk.appBytes * 100 : 0), background: category.color }} title={`${category.label} ${bytes(category.bytes)}`} />)}</div>
      <p className="resource-disk-caption">应用占用 {bytes(disk.appBytes)} · 剩余 {bytes(disk.available)} / 共 {bytes(disk.total)}</p>
      <dl className="resource-storage-categories">{disk.categories.map(category => <div key={category.id}><dt><i style={{ background: category.color }} />{category.label}</dt><dd>{bytes(category.bytes)}</dd></div>)}</dl>
      <div className="resource-storage-roots">{data.roots.filter(root => root.dev === disk.dev).map(root => <div key={root.path}><div><span>{root.label}</span><code>{root.path}</code></div><b>{bytes(root.bytes)}</b></div>)}</div>
    </section>)}
    {data && <p className="resource-footnote">统计网页程序、网页数据与 Codex 数据目录的磁盘分配空间。{data.skipped ? `有 ${data.skipped} 个已移除或无权读取的项目未计入。` : ''}</p>}
  </>;
}

function NetworkPanel({ metrics, requests, onClear, clearing }) {
  const [filter, setFilter] = useState(''), [page, setPage] = useState(0);
  const filtered = requests.items.filter(item => `${item.url} ${item.pid} ${item.method} ${item.process} ${item.status ?? '中断'}`.toLowerCase().includes(filter.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 50)), current = Math.min(page, pages - 1);
  const interfaces = metrics?.network.interfaces || [];
  return <><div className="resource-network-rates"><section><span><ArrowDown size={16} />整机下行</span><strong>{metrics?.network.receivePerSecond == null ? '采样中…' : `${bytes(metrics.network.receivePerSecond)}/s`}</strong></section><section><span><ArrowUp size={16} />整机上行</span><strong>{metrics?.network.sendPerSecond == null ? '采样中…' : `${bytes(metrics.network.sendPerSecond)}/s`}</strong></section></div>
    <p className="resource-network-interfaces">{interfaces.map(item => `${item.name} · 已接收 ${bytes(item.received)} / 已发送 ${bytes(item.sent)}`).join('　')}</p>
    <p className="resource-network-scope">窗口打开期间记录本网页的 API 请求，最多保留最近 1,000 条。不包含 Codex 进程内部的模型请求。</p>
    <div className="resource-network-filter"><label><Search size={15} /><input aria-label="筛选网络请求" value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} placeholder="筛选 URL、进程、PID、方法或状态" /></label><button type="button" disabled={clearing || !requests.items.length} onClick={onClear}><Trash2 size={13} />清空</button></div>
    <div className="resource-network-pagination"><span>{filtered.length} 条 · 已淘汰 {requests.dropped} 条</span><div><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button><b>{current + 1} / {pages}</b><button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</button></div></div>
    <div className="resource-network-table"><table><thead><tr><th>时间</th><th>进程 / PID</th><th>方法</th><th>URL</th><th>状态</th><th>耗时</th></tr></thead><tbody>{filtered.slice(current * 50, (current + 1) * 50).map(item => <tr key={item.id}><td>{time(item.startedAt)}</td><td>{item.process}<small>{item.pid}</small></td><td>{item.method}</td><td className="resource-request-url" title={item.url}>{item.url}</td><td className={item.status == null || item.status >= 400 ? 'resource-status-error' : 'resource-status-ok'}>{item.status ?? '中断'}</td><td>{Math.round(item.durationMs)} ms</td></tr>)}</tbody></table>{!filtered.length && <div className="resource-empty">{filter ? '没有匹配的网络请求' : '暂无请求，网页有操作时会在这里显示'}</div>}</div>
  </>;
}

export default function ResourceManager({ onClose }) {
  const [tab, setTab] = useState('cpu'), [metrics, setMetrics] = useState(null), [session, setSession] = useState(null), [error, setError] = useState('');
  const [storage, setStorage] = useState(null), [storageBusy, setStorageBusy] = useState(false), [storageError, setStorageError] = useState('');
  const [requests, setRequests] = useState({ items: [], dropped: 0 }), [clearing, setClearing] = useState(false);
  const controller = useRef(new AbortController()), tabButtons = useRef({});
  useEffect(() => {
    let disposed = false, timer, id;
    async function poll() {
      try { const data = await request(`/metrics?session=${id}`, controller.current.signal); if (!disposed) { setMetrics(data); setError(''); } }
      catch (error) { if (!disposed && error.name !== 'AbortError') setError('资源信息暂时无法读取，正在重试…'); }
      if (!disposed) timer = setTimeout(poll, 2000);
    }
    request('/sessions', controller.current.signal, 'POST').then(data => { id = data.id; if (!disposed) { setSession(id); poll(); } else fetch(`/api/resources/sessions/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {}); }).catch(error => { if (!disposed && error.name !== 'AbortError') setError('无法连接资源管理器，请关闭后重试'); });
    return () => { disposed = true; clearTimeout(timer); controller.current.abort(); if (id) fetch(`/api/resources/sessions/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (tab !== 'network' || !session) return;
    let disposed = false, timer;
    async function poll() {
      try { const data = await request(`/requests?session=${session}`, controller.current.signal); if (!disposed) setRequests(data); }
      catch (error) { if (!disposed && error.name !== 'AbortError') setError('网络记录暂时无法读取，正在重试…'); }
      if (!disposed) timer = setTimeout(poll, 2000);
    }
    poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [tab, session]);
  async function loadStorage(recalculate = false) {
    setStorageBusy(true); setStorageError('');
    try { setStorage(await request(recalculate ? '/storage/recalculate' : '/storage', controller.current.signal, recalculate ? 'POST' : 'GET')); }
    catch (error) { if (error.name !== 'AbortError') setStorageError('存储统计暂时无法读取，请重新计算'); }
    finally { setStorageBusy(false); }
  }
  useEffect(() => { if (tab === 'storage') loadStorage(); }, [tab]);
  async function clearRequests() {
    setClearing(true);
    try { await request('/requests', controller.current.signal, 'DELETE'); setRequests({ items: [], dropped: 0 }); }
    catch (error) { if (error.name !== 'AbortError') setError('网络记录清空失败，请重试'); }
    finally { setClearing(false); }
  }
  const memory = tab === 'memory';
  return <Modal title="资源管理器" onClose={onClose} className="resource-manager-modal">
    <div className="resource-manager-toolbar"><div><span>{metrics ? `${metrics.processCount} 个进程` : '正在连接…'}</span><small>运行 Codex 的这台电脑</small></div><div role="tablist" aria-label="资源分类" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault();
      const focused = event.target.closest('[role=tab]')?.id.replace('resource-tab-', '') || tab;
      const index = tabs.findIndex(item => item.id === focused), next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]; setTab(next.id); tabButtons.current[next.id]?.focus();
    }}>{tabs.map(({ id, label, icon: Icon }) => <button key={id} ref={button => { tabButtons.current[id] = button; }} id={`resource-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`resource-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}><Icon size={14} />{label}</button>)}</div></div>
    <div className="resource-manager-body" role="tabpanel" id={`resource-panel-${tab}`} aria-labelledby={`resource-tab-${tab}`}>
      {error && <div className="resource-error" role="alert">{error}</div>}
      {(tab === 'cpu' || memory) && <>{!metrics ? <div className="resource-loading"><LoaderCircle size={20} className="spin" />正在读取本机资源…</div> : <><UsageCard label={memory ? '内存' : 'CPU'} icon={memory ? MemoryStick : Cpu} value={memory ? bytes(metrics.memory.appRss) : percent(metrics.cpu.appPercent)} system={memory ? `${bytes(metrics.memory.used)} / ${bytes(metrics.memory.total)}` : percent(metrics.cpu.systemPercent)} appPercent={memory ? metrics.memory.appRss / metrics.memory.total * 100 : metrics.cpu.appPercent} systemPercent={memory ? metrics.memory.used / metrics.memory.total * 100 : metrics.cpu.systemPercent} note={memory ? '进程内存按 RSS 合计，包含共享页。' : metrics.cpu.appPercent == null ? '正在建立采样基线，下一次刷新显示 CPU 用量。' : `每 2 秒更新 · CPU 按整机 ${metrics.cores} 核总容量统计`} /><Processes metrics={metrics} tab={tab} /></>}</>}
      {tab === 'storage' && <Storage data={storage} busy={storageBusy} error={storageError} onRecalculate={() => loadStorage(true)} />}
      {tab === 'network' && <NetworkPanel metrics={metrics} requests={requests} onClear={clearRequests} clearing={clearing} />}
    </div>
    <div className="resource-manager-footer"><span className={metrics ? 'resource-live-dot' : 'resource-live-dot waiting'} />{metrics ? `最近更新 ${time(metrics.timestamp)}` : '等待本机数据'}<span>关闭窗口后停止采样</span></div>
  </Modal>;
}
