import React, { useEffect, useRef, useState } from 'react';
import { Archive, ChevronRight, Folder, History, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { Modal } from './Sidebar.jsx';

const date = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);

export default function HistoryDialog({ onClose, onOpen }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [cwd, setCwd] = useState('');
  const [data, setData] = useState({ items: [], total: 0, workspaces: [] });
  const [busy, setBusy] = useState(true);
  const [opening, setOpening] = useState(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(null);
  const lastRefresh = useRef(0);
  async function load(cursor, signal, force = false) {
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ q: query, archived: status, cwd, ...(cursor ? { cursor } : {}), ...(force ? { refresh: '1' } : {}) });
      const response = await fetch(`/api/history?${params}`, { signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '历史会话读取失败');
      if (signal.aborted) return;
      setData(previous => ({ ...result, items: cursor ? [...previous.items, ...result.items] : result.items }));
    } catch (error) { if (error.name !== 'AbortError') setError(error.message); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    pending.current?.abort(); pending.current = controller;
    setBusy(true);
    const timer = setTimeout(() => {
      const force = refresh !== lastRefresh.current;
      lastRefresh.current = refresh;
      load(null, controller.signal, force);
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, status, cwd, refresh]);
  useEffect(() => () => pending.current?.abort(), []);
  async function open(item) {
    setOpening(item.key); setError('');
    try { await onOpen(item.key); onClose(); }
    catch (error) { setError(error.message); }
    finally { setOpening(null); }
  }
  return <Modal title="全部历史会话" onClose={() => { if (!opening) onClose(); }} className="history-modal">
    <p className="workspace-picker-caption">查看这台电脑上的 Codex 与网页会话，包含所有工作区。</p>
    <div className="history-search"><Search size={17} /><input aria-label="搜索全部历史" placeholder="搜索标题或工作区路径…" value={query} onChange={event => setQuery(event.target.value)} disabled={!!opening} /><button className="icon-button" aria-label="刷新历史会话" disabled={busy || !!opening} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} className={busy ? 'spin' : ''} /></button></div>
    <div className="history-filters"><select aria-label="历史会话状态" value={status} disabled={!!opening} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="false">未归档</option><option value="true">已归档</option></select><select aria-label="历史会话工作区" value={cwd} disabled={!!opening} onChange={event => setCwd(event.target.value)}><option value="">全部工作区</option>{data.workspaces.map(folder => <option key={folder} value={folder}>{folder}</option>)}</select><span>{busy ? '正在读取…' : `${data.total} 个会话`}</span></div>
    {data.warning && <div className="directory-error" role="alert">{data.warning}</div>}{error && <div className="directory-error" role="alert">{error}</div>}
    <div className="history-list" aria-label="全部历史会话列表" aria-busy={busy}>
      {data.items.map(item => <button key={item.key} className="history-row" disabled={!!opening || busy} onClick={() => open(item)}><span className="history-row-icon">{opening === item.key ? <LoaderCircle size={19} className="spin" /> : item.archived ? <Archive size={19} /> : <History size={19} />}</span><span className="history-row-content"><strong>{item.title}</strong><small><Folder size={12} /><span title={item.cwd}>{item.cwd}</span></small><span className="history-row-meta"><time>{date(item.updatedAt)}</time><b>{item.source === 'codex' ? 'Codex' : '网页'}</b>{item.archived && <b>已归档</b>}</span></span><ChevronRight size={15} /></button>)}
      {!data.items.length && <div className="directory-empty">{busy ? <><LoaderCircle size={22} className="spin" />正在读取历史会话…</> : <><History size={26} />{query || cwd || status !== 'all' ? '没有匹配的会话' : '还没有历史会话'}</>}</div>}
      {data.nextCursor && <button className="history-load-more" disabled={busy || !!opening} onClick={() => {
        const controller = new AbortController(); pending.current?.abort(); pending.current = controller; load(data.nextCursor, controller.signal);
      }}>{busy ? <LoaderCircle size={16} className="spin" /> : '加载更多'}</button>}
    </div>
  </Modal>;
}
