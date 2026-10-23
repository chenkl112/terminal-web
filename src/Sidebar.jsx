import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, ArrowLeft, ArrowUp, ChartNoAxesColumnIncreasing, Check, ChevronDown, ChevronRight, Folder,
  FolderOpen, LoaderCircle, MessageCirclePlus, MessageSquare, MoreHorizontal, PanelLeftClose, Pin, PinOff, Plus,
  Search, SquarePen, History, X } from 'lucide-react';

async function request(url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function Popover({ anchor, label, onClose, children, className = '' }) {
  const element = useRef(null);
  const [position, setPosition] = useState({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 260)), top: anchor.bottom + 6 });
  useLayoutEffect(() => {
    const bounds = element.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - bounds.height - 8)) });
    element.current.querySelector('[role=menuitem]:not(:disabled)')?.focus();
  }, [anchor]);
  useEffect(() => {
    const close = event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', close);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  return createPortal(<><div className="sidebar-menu-scrim" onClick={onClose} /><div ref={element} role="menu" aria-label={label} className={`sidebar-popover ${className}`} style={position} onKeyDown={event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...element.current.querySelectorAll('[role=menuitem]:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
  }}>{children}</div></>, document.body);
}

export function Modal({ title, onClose, children, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    (ref.current.querySelector('input') || ref.current.querySelector('button'))?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(<div className="workspace-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={ref} className={`workspace-modal ${className}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const elements = [...ref.current.querySelectorAll('input:not(:disabled),button:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')];
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭窗口" onClick={onClose}><X size={18} /></button></header>{children}</section></div>, document.body);
}

export function ConversationActions({ conversation, onPatch, header = false, disabled = false }) {
  const [anchor, setAnchor] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const trigger = useRef(null);
  const close = () => { setAnchor(null); trigger.current?.focus(); };
  async function change(patch) {
    setBusy(true);
    try { await onPatch(conversation.id, patch); close(); }
    catch { /* The app displays the server's error. */ }
    finally { setBusy(false); }
  }
  return <><button ref={trigger} type="button" data-conversation-menu className={header ? 'icon-button' : 'conversation-more'} aria-label={header ? '对话操作' : `对话操作：${conversation.title}`} aria-haspopup="menu" aria-expanded={!!anchor} disabled={disabled || !conversation} onClick={event => setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect())}><MoreHorizontal size={header ? 19 : 16} /></button>
    {anchor && <Popover anchor={anchor} label="对话操作" onClose={close}>
      {!conversation.archivedAt && <button role="menuitem" disabled={busy} onClick={() => change({ pinned: !conversation.pinnedAt })}>{conversation.pinnedAt ? <PinOff size={16} /> : <Pin size={16} />}{conversation.pinnedAt ? '取消固定' : '固定对话'}</button>}
      <button role="menuitem" disabled={busy} onClick={() => { close(); setTitle(conversation.title); setRenaming(true); }}><SquarePen size={16} />重命名</button>
      <div className="sidebar-menu-divider" />
      <button role="menuitem" disabled={busy || conversation.status === 'active'} onClick={() => change({ archived: !conversation.archivedAt })}>{busy ? <LoaderCircle size={16} className="spin" /> : conversation.archivedAt ? <ArchiveRestore size={16} /> : <Archive size={16} />}{conversation.archivedAt ? '恢复对话' : '归档对话'}</button>
    </Popover>}
    {renaming && <Modal title="重命名对话" onClose={() => { if (!busy) setRenaming(false); }} className="rename-modal"><form onSubmit={async event => {
      event.preventDefault(); setBusy(true);
      try { await onPatch(conversation.id, { title }); setRenaming(false); }
      catch { /* Keep the edit available after a failed save. */ }
      finally { setBusy(false); }
    }}><label htmlFor={`rename-${conversation.id}`}>对话名称</label><input autoFocus id={`rename-${conversation.id}`} value={title} maxLength={100} onChange={event => setTitle(event.target.value)} /><footer><button type="button" disabled={busy} onClick={() => setRenaming(false)}>取消</button><button className="primary" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : '保存'}</button></footer></form></Modal>}
  </>;
}

function WorkspacePicker({ initialPath, onClose, onSelect }) {
  const [current, setCurrent] = useState(null);
  const [input, setInput] = useState(initialPath || '');
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  async function browse(folder, includeHidden = hidden) {
    const version = ++sequence.current;
    setLoading(true); setError('');
    try {
      const result = await request(`/api/directories?path=${encodeURIComponent(folder || '')}&hidden=${includeHidden ? '1' : '0'}`);
      if (version === sequence.current) { setCurrent(result); setInput(result.path); }
    } catch (error) { if (version === sequence.current) setError(error.message); }
    finally { if (version === sequence.current) setLoading(false); }
  }
  useEffect(() => { browse(initialPath); return () => { sequence.current++; }; }, []);
  async function choose() {
    setSaving(true); setError('');
    try { const workspace = await request('/api/workspaces', { path: current.path }); await onSelect(workspace); onClose(); }
    catch (error) { setError(error.message); }
    finally { setSaving(false); }
  }
  return <Modal title="打开工作区" onClose={() => { if (!saving) onClose(); }}><p className="workspace-picker-caption">选择运行 Codex 的这台电脑上的文件夹。</p>
    <form className="directory-path" onSubmit={event => { event.preventDefault(); browse(input); }}><button type="button" className="icon-button" aria-label="上一级文件夹" disabled={!current?.parent || loading || saving} onClick={() => browse(current.parent)}><ArrowUp size={17} /></button><input aria-label="工作区文件夹路径" value={input} onChange={event => setInput(event.target.value)} disabled={saving || loading} /><button disabled={loading || saving} aria-label="前往文件夹"><ChevronRight size={18} /></button></form>
    <div className="directory-options"><span>{current?.folders.length ?? 0} 个文件夹</span><label><input type="checkbox" checked={hidden} disabled={saving} onChange={event => { setHidden(event.target.checked); browse(current?.path || input, event.target.checked); }} />显示隐藏文件夹</label></div>
    <div className="directory-list" aria-label="本机文件夹" aria-busy={loading}>{loading ? <div className="directory-empty"><LoaderCircle className="spin" size={20} />正在读取文件夹…</div> : current?.folders.length ? current.folders.map(folder => <button key={folder.path} disabled={saving} onClick={() => browse(folder.path)}><Folder size={19} /><span>{folder.name}</span><ChevronRight size={14} /></button>) : <div className="directory-empty"><FolderOpen size={25} />此文件夹内没有子文件夹</div>}</div>
    {error && <div className="directory-error" role="alert">{error}</div>}
    <footer><span title={current?.path}>{current?.path || '请选择文件夹'}</span><button disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={!current || loading || saving || !!error || input !== current.path} onClick={choose}>{saving ? <LoaderCircle size={15} className="spin" /> : '选择此文件夹'}</button></footer>
  </Modal>;
}

export default function Sidebar({ mark, workspaces, workspace, conversations, activeId, connected, ready, creating,
  onClose, onNew, onSelectChat, onSelectWorkspace, onAddWorkspace, onPatch, onHistory, onUsageStats }) {
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [archived, setArchived] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(null);
  const [picker, setPicker] = useState(false);
  useEffect(() => { setArchived(false); setSearch(''); }, [workspace?.id]);
  const current = conversations.filter(c => c.workspaceId === workspace?.id);
  const visible = current.filter(c => !!c.archivedAt === archived && c.title.toLowerCase().includes(search.toLowerCase()));
  const pinned = visible.filter(c => c.pinnedAt).sort((a, b) => b.pinnedAt - a.pinnedAt);
  const recent = visible.filter(c => !c.pinnedAt).sort((a, b) => archived ? b.archivedAt - a.archivedAt : (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  const archivedCount = current.filter(c => c.archivedAt).length;
  function row(c) {
    return <div key={c.id} data-conversation-id={c.id} className={`conversation-row ${c.id === activeId ? 'selected' : ''}`} onContextMenu={event => { event.preventDefault(); event.currentTarget.querySelector('[data-conversation-menu]')?.click(); }}><button className={`conversation-link ${c.id === activeId ? 'active' : ''}`} onClick={() => onSelectChat(c.id)} title={c.title}>{c.pinnedAt ? <Pin size={13} /> : <MessageSquare size={14} />}<span>{c.title}</span>{c.status === 'active' && <span className="working-dot" />}</button><ConversationActions conversation={c} onPatch={onPatch} disabled={!connected} /></div>;
  }
  return <><div className="sidebar-backdrop" onClick={onClose} /><aside className="sidebar">
    <div className="brand-row"><div className="brand"><span className="brand-symbol">{mark}</span><span>Codex</span><span className="local-badge">本地</span></div><button className="icon-button" aria-label="收起侧栏" onClick={onClose}><PanelLeftClose size={17} /></button></div>
    <div className="sidebar-actions"><button className="new-chat" aria-label="新建任务" title="新建任务 (Ctrl+N)" onClick={() => { setArchived(false); onNew(); }} disabled={creating || !ready}><MessageCirclePlus size={19} /><span>新建任务</span><kbd aria-hidden="true">Ctrl+N</kbd></button><button className="sidebar-history" onClick={onHistory}><History size={16} /><span>全部历史</span></button><button className="sidebar-search" onClick={() => setShowSearch(!showSearch)}><Search size={16} /><span>搜索对话</span></button></div>
    {showSearch && <div className="search-field"><Search size={13} /><input autoFocus aria-label="搜索对话" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索当前工作区…" /><button aria-label="关闭搜索" onClick={() => { setShowSearch(false); setSearch(''); }}><X size={12} /></button></div>}
    <div className="sidebar-section-label workspace-section-heading"><span>工作区</span><button className="icon-button" title="打开文件夹" aria-label="打开工作区文件夹" disabled={!connected} onClick={() => setPicker(true)}><Plus size={16} /></button></div>
    <button className="project-row workspace-switcher" aria-label="选择工作区" aria-haspopup="menu" aria-expanded={!!workspaceMenu} disabled={!connected} title={workspace?.path} onClick={event => setWorkspaceMenu(workspaceMenu ? null : event.currentTarget.getBoundingClientRect())}><FolderOpen size={17} /><strong>{workspace?.name || '正在连接…'}</strong><ChevronDown size={14} /></button>
    {workspaceMenu && <Popover anchor={workspaceMenu} label="选择工作区" onClose={() => setWorkspaceMenu(null)} className="workspace-list-menu"><div className="sidebar-menu-heading">工作区</div>{workspaces.map(w => <button role="menuitem" key={w.id} onClick={() => { setWorkspaceMenu(null); onSelectWorkspace(w.id); }}><Folder size={16} /><span><strong>{w.name}</strong><small>{w.path}</small></span>{w.id === workspace?.id && <Check size={15} />}</button>)}<div className="sidebar-menu-divider" /><button role="menuitem" onClick={() => { setWorkspaceMenu(null); setPicker(true); }}><Plus size={16} />打开文件夹…</button></Popover>}
    <nav className="conversation-list" aria-label="对话列表">
      {archived ? <div className="conversation-section-heading archive-heading"><button onClick={() => setArchived(false)} aria-label="返回最近对话"><ArrowLeft size={14} /></button><span>已归档</span><b>{archivedCount}</b></div> : <>{pinned.length > 0 && <div className="conversation-section-heading">已固定</div>}{pinned.map(row)}</>}
      {!archived && <div className="conversation-section-heading">最近对话</div>}{recent.map(row)}
      {!visible.length && <div className="conversation-empty">{search ? '没有找到相关对话' : archived ? '没有归档的对话' : '在这里开始新的对话'}</div>}
    </nav>
    <div className="sidebar-bottom"><button className={`archive-entry ${archived ? 'selected' : ''}`} aria-label="查看已归档对话" aria-pressed={archived} onClick={() => { setArchived(!archived); setSearch(''); }}><Archive size={15} /><span>已归档</span>{archivedCount > 0 && <b>{archivedCount}</b>}</button><button className="usage-stats-entry" onClick={onUsageStats}><ChartNoAxesColumnIncreasing size={15} /><span>使用统计</span></button><div className="workspace-location"><Folder size={14} /><span title={workspace?.path}>{workspace?.path || '正在连接…'}</span></div><div className={`connection-info ${connected ? 'is-connected' : ''}`}><span className={connected ? 'connection-light' : 'connection-light offline'} /><span>{connected ? '局域网已连接' : '正在重新连接'}</span><span className="machine-label">此设备</span></div></div>
  </aside>{picker && <WorkspacePicker initialPath={workspace?.path} onClose={() => setPicker(false)} onSelect={onAddWorkspace} />}</>;
}
