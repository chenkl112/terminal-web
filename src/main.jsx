import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive, ArchiveRestore, ArrowUp, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Code2, Copy,
  Database, Download, File, FileCode2, FileText, Folder, FolderOpen, Gauge, Image, Keyboard, LoaderCircle, LockKeyhole,
  MessageCirclePlus, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Paperclip, Plus,
  RefreshCw, Search, Send, ShieldCheck, Square, SquarePen, TerminalSquare, Upload,
  Wifi, WifiOff, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bindTerminalCopyKeys, bindTerminalDirectCopy, copyTerminalSelection } from './terminalClipboard.js';
import { bindTerminalNativeCopy } from './terminalNativeCopy.js';
import { writeTerminalOutput } from './terminalOutput.js';
import { bindTerminalScrolling } from './terminalScroll.js';
import { useChatScroll } from './useChatScroll.js';
import { OutputSpeedTracker } from './outputSpeed.js';
import { SessionStatsTracker, sessionDuration } from './sessionStats.js';
import { reconnectDelay } from './reconnect.js';
import { mergeConversationPatch } from '../shared/conversationPatch.js';
import { groupMessageItems, processMessageGroups, processSummary } from '../shared/messageGroups.js';
import ChatContent from './ChatContent.jsx';
import TerminalKeyboard from './TerminalKeyboard.jsx';
import TerminalDownloads from './TerminalDownloads.jsx';
import { normalizeTerminalDownloadPath, createTerminalFileLinkProvider, collectTerminalDownloadPaths } from './terminalDownloads.js';
import { usageMetrics } from '../shared/conversation.js';
import { validateSettings } from '../shared/settings.js';
import { terminalDraftKey, terminalFilePaths, terminalInputChunks } from '../shared/terminalFiles.js';
import SessionControls from './SessionControls.jsx';
import { MessageMarkdown as Markdown, NativeImage } from './GeneratedMedia.jsx';
import SlashMenu, { parseSlash, slashCommands } from './SlashMenu.jsx';
import CommandDialog from './CommandDialog.jsx';
import GoalDialog from './GoalDialog.jsx';
import ResourceManager from './ResourceManager.jsx';
import { startResourceMonitoring } from './resourceMetrics.js';
import UsageStats from './UsageStats.jsx';
import './commands.css';
import Sidebar, { ConversationActions, Modal } from './Sidebar.jsx';
import HistoryDialog from './History.jsx';
import { uploadId, sendFile, sendFolder, droppedFiles, folderFromFiles } from './uploads.js';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './sidebar.css';
import './history.css';
import './usage.css';
import './theme.css';
import './refinement.css';
import './terminalKeyboard.css';
import './terminalFiles.css';
import './resources.css';
import './zcodeTheme.css';
import './usageStats.css';
import './taskUsage.css';
import './workStatus.css';
import './mobileTerminal.css';
import './chatScroll.css';
import './messageTimeline.css';
import './harnessWorkspace.css';
import './dialogTheme.css';

const terminalBus = new EventTarget();
const terminalBuffers = new Map();
const n = value => value == null ? '—' : new Intl.NumberFormat('en-US').format(value);
const short = value => value == null ? '—' : value >= 1000000 ? `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
const bytes = size => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(0)} KB` : `${size} B`;
const upsert = (list, item) => list.some(i => i.id === item.id) ? list.map(i => i.id === item.id ? item : i) : [...list, item];
function savedDrafts() {
  try { return JSON.parse(localStorage.getItem('mono-drafts') || '{}'); } catch { return {}; }
}
function savedTaskDrafts() {
  try {
    const saved = JSON.parse(localStorage.getItem('mono-task-drafts') || '{}');
    return Object.fromEntries(Object.entries(saved).filter(([workspaceId, draft]) =>
      draft?.isDraft && draft.workspaceId === workspaceId && draft.id?.startsWith('draft-') && Array.isArray(draft.turns)));
  } catch { return {}; }
}
function taskDraft(workspace, template, defaultModel) {
  return { id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, title: '新建任务', workspaceId: workspace.id, cwd: workspace.path,
    model: template?.model || defaultModel?.model, effort: template?.effort || defaultModel?.defaultReasoningEffort,
    permissionMode: template?.permissionMode || 'workspace-write', fast: template?.fast || false, mode: template?.mode || 'default',
    turns: [], status: 'idle', archivedAt: null, attachments: {}, isDraft: true };
}

async function api(url, body, method = 'POST') {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let data;
  try { data = await response.json(); } catch { throw new Error('服务器响应异常'); }
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function Mark({ large = false }) {
  return <span className={`codex-mark ${large ? 'large' : ''}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" /></svg></span>;
}
function CircleProgress({ value, error = false, done = false, size = 32 }) {
  return <span className={`circle-progress ${done ? 'done' : ''} ${error ? 'failed' : ''}`} style={{ width: size, height: size }} role={error || done ? 'img' : 'progressbar'} aria-label={error ? '上传失败' : done ? '上传完成' : '上传进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
    <svg viewBox="0 0 36 36"><circle className="ring-track" cx="18" cy="18" r="15" /><circle className="ring-value" cx="18" cy="18" r="15" strokeDasharray="94.248" strokeDashoffset={94.248 * (1 - value / 100)} /></svg>
    <span>{error ? <X size={12} /> : done ? <Check size={13} /> : <b>{Math.round(value)}</b>}</span>
  </span>;
}

function Login({ onSuccess }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/api/login', { key }); onSuccess(); } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <div className="login-screen"><form onSubmit={submit} className="login-card"><Mark large /><p className="eyebrow">YOUR LOCAL WORKSPACE</p><h1>连接你的 Codex</h1><p>输入访问 key，继续你的工作。</p><label htmlFor="access-key">访问 key</label><div className="key-input"><LockKeyhole size={17} /><input autoFocus id="access-key" type="password" value={key} onChange={e => setKey(e.target.value)} required placeholder="输入访问 key" /></div>{error && <div className="inline-error" role="alert">{error}</div>}<button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : '进入工作区'}<ChevronRight size={16} /></button><small><ShieldCheck size={13} /> 会话通过此设备上的 Codex 运行</small></form></div>;
}

function FileBadge({ file }) {
  return <a className="sent-file" href={file.url} target="_blank" rel="noreferrer">{file.kind === 'folder' ? <Folder size={21} /> : file.image ? <img src={file.url} alt={file.name} /> : <FileText size={21} />}<span><strong>{file.name}</strong><small>{file.kind === 'folder' ? `${file.fileCount} 个文件 · ` : ''}{bytes(file.size)} · 已上传到本机</small></span></a>;
}
function CopyMessageButton({ text }) {
  const [copied, setCopied] = useState(false);
  return <button className="copy-button" title="复制回复" aria-label="复制回复" onClick={async () => {
    try { await navigator.clipboard.writeText(text); }
    catch { const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); document.execCommand('copy'); area.remove(); }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}
function Item({ item, conversation, grouped = false }) {
  if (item.type === 'userMessage') {
    const local = conversation.attachments[item.clientId] || Object.values(conversation.attachments).find(a => {
      const text = item.content?.find(c => c.type === 'text')?.text || '';
      return a.files.length && a.files.every(f => text.includes(f.path));
    });
    const text = local?.text ?? item.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return <div className="message user-message">{local?.files?.length > 0 && <div className="sent-files">{local.files.map(f => <FileBadge key={f.id} file={f} />)}</div>}{text && <div className="user-bubble">{text}</div>}</div>;
  }
  if (item.type === 'agentMessage') {
    if (!item.text) return null;
    return <div className={`message agent-message ${item.phase === 'commentary' ? 'commentary-message' : ''}`}>{!grouped && <div className="agent-label"><Mark /><span>Codex</span></div>}<Markdown text={item.text} conversation={conversation} />{!grouped && item.phase !== 'commentary' && <CopyMessageButton text={item.text} />}</div>;
  }
  if (item.type === 'imageView' || item.type === 'imageGeneration') return <NativeImage item={item} conversation={conversation} />;
  if (item.type === 'reasoning') {
    const summary = item.summary?.join('\n');
    if (!summary) return null;
    return <details className="activity reasoning"><summary><span className="activity-dot" />思考过程<ChevronRight size={13} /></summary><Markdown text={summary} conversation={conversation} /></details>;
  }
  if (item.type === 'commandExecution') {
    return <details className="activity tool-activity"><summary><TerminalSquare size={14} /><span className="command-label">{item.command}</span>{item.status === 'inProgress' ? <LoaderCircle className="spin" size={13} /> : <span className="tool-status">{item.exitCode === 0 ? '完成' : `退出 ${item.exitCode ?? '—'}`}</span>}<ChevronRight size={13} /></summary>{item.aggregatedOutput && <pre>{item.aggregatedOutput}</pre>}</details>;
  }
  if (item.type === 'fileChange') {
    return <details className="activity"><summary><FileCode2 size={14} />编辑了 {item.changes?.length || 0} 个文件<ChevronRight size={13} /></summary>{item.changes?.map((change, i) => <div className="file-change" key={i}><b>{change.path}</b><pre>{change.diff}</pre></div>)}</details>;
  }
  if (item.type === 'dynamicToolCall') return <details className="activity tool-activity"><summary><TerminalSquare size={14} /><span className="command-label">{item.tool || '工具调用'}</span><ChevronRight size={13} /></summary><pre>{JSON.stringify(item.contentItems || item.output || item.arguments, null, 2)}</pre></details>;
  if (item.type === 'mcpToolCall') return <details className="activity"><summary><Code2 size={14} />{item.server} / {item.tool}<ChevronRight size={13} /></summary><pre>{JSON.stringify(item.result || item.error || item.arguments, null, 2)}</pre></details>;
  if (item.type === 'webSearch') return <div className="activity inline-activity"><Search size={14} />正在搜索：{item.query || item.action?.query || '网络资料'}</div>;
  if (item.type === 'contextCompaction') return <div className="context-notice">上下文已压缩 · 对话可继续</div>;
  if (item.type === 'plan' && item.text) return <div className="plan"><Markdown text={item.text} conversation={conversation} /></div>;
  return null;
}

function ProcessMessages({ items, conversation }) {
  const [mounted, setMounted] = useState(false);
  if (items.length === 1) return <Item item={items[0]} conversation={conversation} grouped />;
  const preview = items.findLast(item => item.text?.trim())?.text?.trim().replace(/\s+/g, ' ');
  return <details className="message-stack" onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open) setMounted(true); }}>
    <summary><span>{items.length} 条过程消息</span><ChevronRight size={13} /><span className="message-stack-preview">{preview}</span></summary>
    {mounted && <div className="message-stack-body">{items.map(item => <Item key={item.id} item={item} conversation={conversation} grouped />)}</div>}
  </details>;
}

function ExecutionGroup({ items, conversation, active, turnStatus }) {
  const [mounted, setMounted] = useState(false);
  const summary = processSummary(items);
  const status = summary.failed ? `${summary.failed} 项失败` : turnStatus === 'interrupted' ? '已停止' : turnStatus === 'failed' ? '未完成' : '已完成';
  return <details className="activity command-group execution-group process-disclosure" onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open) setMounted(true); }}>
    <summary><span className="process-icon"><TerminalSquare size={14} /></span><span className="process-heading"><span className="process-title">{active ? '正在处理' : '工作过程'}<small>· {summary.operations ? `${summary.operations} 项` : `${items.length} 条`}</small></span>{summary.detail && <span className="process-detail">{summary.detail}</span>}{active && summary.preview && <span className="process-preview">{summary.preview}</span>}</span>{active ? <LoaderCircle className="spin" size={13} /> : <span className={`tool-status ${summary.failed ? 'command-failed' : ''}`}>{status}</span>}<ChevronRight size={13} /></summary>
    {mounted && <div className="command-group-items process-timeline">{processMessageGroups(items).map(group => <div className="process-entry" key={group.key}>{group.kind === 'commentary' ? <ProcessMessages items={group.items} conversation={conversation} /> : <Item item={group.items[0]} conversation={conversation} grouped />}</div>)}</div>}
  </details>;
}

const TurnItems = memo(function TurnItems({ turn, conversation }) {
  const blocks = groupMessageItems(turn.items);
  return blocks.map((block, index) => {
    if (block.kind === 'process') return <ExecutionGroup key={block.key} items={block.items} conversation={conversation} active={turn.status === 'inProgress' && index === blocks.length - 1} turnStatus={turn.status} />;
    if (block.kind === 'assistant') {
      const items = block.items.filter(item => item.text?.trim());
      if (!items.length) return null;
      return <section className="assistant-run message" key={block.key} aria-label="Codex 回复"><div className="agent-label"><Mark /><span>Codex</span></div>{items.map(item => <Item key={item.id} item={item} conversation={conversation} grouped />)}<CopyMessageButton text={items.map(item => item.text).join('\n\n')} /></section>;
    }
    if (block.kind === 'user' && block.items.length > 1) return <div className="user-message-batch" key={block.key}><details className="user-message-history"><summary>{block.items.length} 条连续消息<ChevronRight size={12} /></summary>{block.items.slice(0, -1).map(item => <Item key={item.id} item={item} conversation={conversation} />)}</details><Item item={block.items.at(-1)} conversation={conversation} /></div>;
    return <Item key={block.key} item={block.items[0]} conversation={conversation} />;
  });
});

function Approval({ request, onError }) {
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const questions = request.params.questions;
  async function respond(decision) {
    setBusy(true);
    try {
      const body = questions ? { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [answers[q.id] || ''] }])) } : { decision };
      await api(`/api/approvals/${request.id}`, body);
    } catch (error) { onError(error.message); setBusy(false); }
  }
  return <div className="approval"><div className="approval-title"><CircleHelp size={17} /><b>{questions ? 'Codex 需要你的回答' : '需要你的确认'}</b></div>{questions ? questions.map(q => <div key={q.id} className="question"><label htmlFor={`question-${q.id}`}>{q.question}</label>{q.options && <div className="answer-options">{q.options.map(o => <button key={o.label} className={answers[q.id] === o.label ? 'selected' : ''} title={o.description} onClick={() => setAnswers(a => ({ ...a, [q.id]: o.label }))}>{o.label}</button>)}</div>}<input id={`question-${q.id}`} type={q.isSecret ? 'password' : 'text'} value={answers[q.id] || ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} placeholder="输入回答…" /></div>) : <><p>{request.params.reason || request.params.message || (request.method.includes('fileChange') ? 'Codex 希望修改以下文件。' : 'Codex 请求执行此操作。')}</p><pre>{request.params.command || request.params.grantRoot || JSON.stringify(request.params.permissions || request.params.changes || {}, null, 2)}</pre></>}<div className="approval-actions">{!questions && <button disabled={busy} onClick={() => respond('decline')}>拒绝</button>}<button className="primary" disabled={busy || (questions && questions.some(q => !answers[q.id]?.trim()))} onClick={() => respond('accept')}>{questions ? '提交回答' : '允许本次'}</button></div></div>;
}

function TokenBar({ usage, outputSpeed, sessionStats }) {
  const [open, setOpen] = useState(null);
  const [hovered, setHovered] = useState(null);
  const footer = useRef(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (!footer.current?.contains(event.target)) { setOpen(null); setHovered(null); }
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('wheel', dismiss, { capture: true, passive: true });
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('wheel', dismiss, true); };
  }, [open]);
  const metrics = usageMetrics(usage);
  const visible = open || hovered;
  const percentText = metrics.percent == null ? '—' : `${Math.round(metrics.percent)}%`;
  const cacheText = metrics.cacheHit == null ? '—' : `${Math.round(metrics.cacheHit)}%`;
  const speedText = outputSpeed ? outputSpeed.tokensPerSecond.toFixed(1) : '—';
  const toggle = source => { setHovered(null); setOpen(previous => previous === source ? null : source); };
  const hoverProps = source => ({ onPointerEnter: event => { if (event.pointerType === 'mouse') setHovered(source); }, onPointerLeave: () => setHovered(null) });
  return <div ref={footer} className="usage-footer" onKeyDown={event => { if (event.key === 'Escape') { setOpen(null); setHovered(null); } }}>
    <div className="usage-item" {...hoverProps('tokens')}>
      <button className={`token-summary ${visible === 'tokens' ? 'is-open' : ''}`} onClick={() => toggle('tokens')} aria-expanded={visible === 'tokens'} aria-controls="token-usage-popover" aria-label="查看 token 用量">
        <Database size={16} strokeWidth={1.5} aria-hidden="true" /><span><span data-testid="total-tokens">{short(metrics.total)}</span> tok<span className="cache-summary"> · 缓存命中 {cacheText}</span></span>
      </button>
      {visible === 'tokens' && <div id="token-usage-popover" className="usage-popover token-popover" role="region" aria-label="Token 用量详情">
        <header><h3><Database size={16} strokeWidth={1.5} />Token 用量</h3><b>{n(metrics.total)} tok</b></header>
        <div className="usage-row"><span>缓存命中</span><span>{cacheText}</span></div>
        <div className="usage-row"><span>未缓存输入</span><span>{n(metrics.uncached)} tok</span></div>
        <div className="usage-row"><span>缓存读取</span><span>{n(metrics.cached)} tok</span></div>
        <div className="usage-row"><span>输出</span><span>{n(metrics.output)} tok</span></div>
      </div>}
    </div>
    <div className="usage-item" {...hoverProps('context')}>
      <button className={`context-button ${visible === 'context' ? 'is-open' : ''}`} onClick={() => toggle('context')} aria-expanded={visible === 'context'} aria-controls="context-usage-popover" aria-label="查看 token 和上下文用量">
        <svg className="context-ring" width="16" height="16" viewBox="0 0 16 16" role="progressbar" aria-label="上下文使用进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={metrics.percent == null ? undefined : Math.round(metrics.percent)} aria-valuetext={metrics.percent == null ? '等待数据' : percentText}>
          <circle className="context-ring-track" cx="8" cy="8" r="6.25" />
          <circle className="context-ring-value" cx="8" cy="8" r="6.25" pathLength="100" strokeDasharray={`${metrics.percent || 0} 100`} />
        </svg><span data-testid="context-percent">{percentText}</span>
      </button>
      {visible === 'context' && <div id="context-usage-popover" className="usage-popover context-popover" role="region" aria-label="上下文用量详情">
        <header><h3>上下文已用 <b>{percentText}</b></h3><b>{metrics.used == null ? '—' : `~${short(metrics.used)}`} / {short(metrics.capacity)}</b></header>
        <div className="context-composition" role="progressbar" aria-label="上下文总用量进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={metrics.percent == null ? undefined : Math.round(metrics.percent)}><span className="context-part context-total-fill" style={{ width: `${metrics.percent || 0}%` }} /></div>
      </div>}
    </div>
    <div className="usage-item" {...hoverProps('speed')}>
      <button className={`output-speed-button ${visible === 'speed' ? 'is-open' : ''}`} onClick={() => toggle('speed')} aria-label="查看会话统计" aria-expanded={visible === 'speed'} aria-controls="output-speed-popover">
        <Gauge size={15} aria-hidden="true" /><span><span className="session-step-summary">{sessionStats?.rounds ?? 0} 轮 {sessionStats?.steps ?? 0} 步 · </span><span data-testid="output-speed">{speedText}</span> tok/s</span>
      </button>
      {visible === 'speed' && <div id="output-speed-popover" className="usage-popover output-speed-popover" role="region" aria-label="会话统计">
        <header><h3><Gauge size={15} />会话统计</h3><b>{sessionStats?.rounds ?? 0} 轮 {sessionStats?.steps ?? 0} 步</b></header>
        <div className="usage-row" title="本页观测的非工具阶段，包含排队和等待"><span>模型用时</span><span>{sessionDuration(sessionStats?.modelMs)}</span></div>
        <div className="usage-row" title="累计各次调用时长，并行调用分别累计"><span>工具调用用时</span><span>{sessionDuration(sessionStats?.toolMs)}</span></div>
        <div className="usage-row" title="完整观测轮次从开始到首个文本或思考片段的平均等待时间"><span>首 token 平均（TTFT）</span><span>{sessionDuration(sessionStats?.ttftMs)}</span></div>
        <div className="usage-row"><span>输出速度（TPS）</span><span>{speedText} tok/s</span></div>
        <p>计时为网页观测值，TPS 为任务均速；缺失项显示“—”。{(outputSpeed?.partial || sessionStats?.partial) && ' 含中途观测。'}</p>
      </div>}
    </div>
  </div>;
}

function currentWorkPhase(conversation, submitting) {
  if (submitting && !conversation?.activeTurnId) return { label: '正在启动任务' };
  if (conversation?.status !== 'active') return null;
  const turn = conversation.turns.find(item => item.id === conversation.activeTurnId)
    || [...conversation.turns].reverse().find(item => item.status === 'inProgress');
  const items = turn?.items || [];
  const active = [...items].reverse().find(item => item.status === 'inProgress');
  if (active?.type === 'commandExecution') return { label: '正在运行命令', detail: active.command };
  if (active?.type === 'webSearch') return { label: '正在搜索资料', detail: active.query || active.action?.query };
  if (active?.type === 'mcpToolCall') return { label: '正在调用工具', detail: [active.server, active.tool].filter(Boolean).join(' / ') };
  if (active?.type === 'dynamicToolCall') return { label: '正在调用工具', detail: active.tool };
  if (active?.type === 'fileChange') return { label: '正在修改文件', detail: `${active.changes?.length || 0} 个文件` };
  if (active?.type === 'imageGeneration') return { label: '正在生成图片' };
  if (active?.type === 'reasoning') return { label: '正在分析任务' };
  if (active?.type === 'agentMessage') return { label: active.phase === 'commentary' ? '正在处理任务' : '正在生成回复' };
  if (items.some(item => item.type === 'reasoning')) return { label: '正在分析任务' };
  return { label: '正在思考下一步' };
}

function WorkStatus({ conversation, submitting }) {
  const phase = currentWorkPhase(conversation, submitting);
  const turnId = conversation?.activeTurnId || (submitting ? 'submitting' : '');
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    startedAt.current = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [turnId]);
  if (!phase) return null;
  const time = elapsed >= 3600
    ? `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${String(Math.floor(elapsed % 3600 / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
    : `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  return <div className="work-status" role="status" aria-label="任务进度" aria-live="polite"><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span><span className="work-status-label">{phase.label}</span>{phase.detail && <code title={phase.detail}>{phase.detail}</code>}<time>{time}</time></div>;
}

function UploadCard({ file, onRemove, onRetry, onInsert, insertDisabled = false }) {
  const done = file.status === 'done';
  const failed = file.status === 'error';
  return <div className={`upload-card ${failed ? 'has-error' : ''}`} data-testid="upload-card"><div className="upload-preview">{file.preview ? <img src={file.preview} alt="" /> : file.kind === 'folder' ? <Folder size={25} strokeWidth={1.7} /> : <FileText size={25} strokeWidth={1.7} />}<CircleProgress size={30} value={file.progress} done={done} error={failed} /></div><div className="upload-info"><strong title={file.name}>{file.name}</strong><span>{failed ? file.error : done ? `${file.kind === 'folder' ? `${file.server?.fileCount ?? file.files?.length ?? 0} 个文件 · ` : ''}${bytes(file.size)} · 已传到本机` : file.progress >= 99 ? '正在保存到本机…' : <span className="upload-transfer"><span>上传中 · {bytes(file.size)}</span><span className="upload-speed">{file.speed == null ? '测速中…' : `${bytes(file.speed)}/s`}</span></span>}</span>{failed && <button type="button" className="retry-upload" onClick={onRetry}><RefreshCw size={11} />重试</button>}{done && onInsert && <button type="button" className="terminal-insert-path" disabled={insertDisabled} onClick={onInsert}>插入路径</button>}</div><button type="button" className="remove-upload" onClick={onRemove} aria-label={`移除 ${file.name}`} title="移除附件"><X size={13} /></button></div>;
}

const terminalLabel = title => /^终端\s+\d+$/.test(title || '') ? '终端' : title || '终端';

function TerminalView({ terminal, active, connected, socketRef, onRestart, files, onUpload, onRemove, onRetry, onInserted }) {
  const container = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const activeRef = useRef(active); activeRef.current = active;
  const terminalInfoRef = useRef(terminal); terminalInfoRef.current = terminal;
  const scheduleFitRef = useRef(null);
  const [initialized, setInitialized] = useState(active);
  const [ready, setReady] = useState(false);
  useEffect(() => { if (active) setInitialized(true); }, [active]);
  const [hasSelection, setHasSelection] = useState(false);
  const [nativeSelectionText, setNativeSelectionText] = useState('');
  const nativeSelectionRef = useRef('');
  const [copyStatus, setCopyStatus] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [uploadMenu, setUploadMenu] = useState(null);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [filesHidden, setFilesHidden] = useState(false);
  const previousFileCount = useRef(files.length);
  const [uploadStatus, setUploadStatus] = useState('');
  const [downloadDialog, setDownloadDialog] = useState(null);
  const linkedPaths = useRef([]);
  const terminalFileInput = useRef(null), terminalFolderInput = useRef(null), cameraInput = useRef(null);
  useEffect(() => { if (keyboardOpen) setFilesExpanded(false); }, [keyboardOpen]);
  useEffect(() => {
    if (files.length > previousFileCount.current) { setFilesHidden(false); if (!keyboardOpen) setFilesExpanded(true); }
    previousFileCount.current = files.length; setUploadStatus('');
  }, [files.length]);
  useEffect(() => { if (!active) { setUploadMenu(null); setDownloadDialog(null); } }, [active]);
  function openDownloads(filePath = '') {
    const selected = normalizeTerminalDownloadPath(filePath || termRef.current?.getSelection() || '');
    const recent = termRef.current ? collectTerminalDownloadPaths(termRef.current) : [];
    setUploadMenu(null);
    setDownloadDialog({ path: selected, paths: [...new Set([selected, ...recent, ...linkedPaths.current].filter(Boolean))].slice(0, 30) });
  }
  function insertPaths(selected) {
    if (!ready || !connected || terminal.exited || !termRef.current) return;
    const completed = selected.filter(file => file.status === 'done' && terminalFilePaths([file]));
    const text = terminalFilePaths(completed);
    if (!text) return;
    termRef.current.paste(text); termRef.current.scrollToBottom();
    onInserted(completed);
    if (!window.matchMedia('(pointer: coarse)').matches) termRef.current.focus();
    setUploadStatus('已插入路径，按回车提交');
  }
  async function copySelection() {
    const text = termRef.current?.getSelection() || nativeSelectionRef.current;
    try { setCopyStatus(await copyTerminalSelection({ getSelection: () => text }) ? '已复制' : '请先选择文字后复制'); }
    catch { setCopyStatus('复制失败，请使用右键菜单复制'); }
  }
  useEffect(() => {
    if (!initialized) return;
    let disposed = false, frame = 0, replayVersion = 0, replaying = true, synchronizeAfterFit = false, detectedCodex = false;
    const term = new Terminal({ cols: terminal.cols || 100, rows: terminal.rows || 30,
      linkHandler: { allowNonHttpProtocols: true, activate(event, uri) {
        if (termRef.current?.hasSelection()) { event.preventDefault(); return; }
        const filePath = normalizeTerminalDownloadPath(uri);
        if (filePath) { event.preventDefault(); openDownloads(filePath); }
        else if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
      } },
      cursorBlink: true, macOptionClickForcesSelection: true, fontSize: window.matchMedia('(pointer: coarse)').matches ? 13 : 14, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: 1.35,
      scrollback: 10000, theme: { background: '#161616', foreground: '#dedede', cursor: '#eeeeee', selectionBackground: '#ffffff30', black: '#333333', brightBlack: '#777777', white: '#dedede', brightWhite: '#ffffff' } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current); termRef.current = term; fitRef.current = fit;
    const fileLinks = term.registerLinkProvider(createTerminalFileLinkProvider(term, openDownloads));
    const oscLinks = term.parser.registerOscHandler(8, data => {
      const filePath = normalizeTerminalDownloadPath(data.slice(data.indexOf(';') + 1));
      if (filePath) linkedPaths.current = [filePath, ...linkedPaths.current.filter(value => value !== filePath)].slice(0, 30);
      return false;
    });
    bindTerminalCopyKeys(term, copySelection);
    const isCodex = () => (terminalInfoRef.current.isDefault || detectedCodex) && !terminalInfoRef.current.exited;
    const nativeSelection = () => isCodex() && ['vt200', 'drag', 'any'].includes(term.modes.mouseTrackingMode);
    const unbindDirectCopy = bindTerminalDirectCopy(term, copySelection, { nativeSelection, hasNativeSelection: () => !!nativeSelectionRef.current });
    const unbindNativeCopy = bindTerminalNativeCopy(term, {
      enabled: () => activeRef.current && !replaying && nativeSelection(),
      onSelection: text => { nativeSelectionRef.current = text; setNativeSelectionText(text); }, onStatus: setCopyStatus,
    });
    // Codex launched inside a normal shell is still a Codex UI. Its activity
    // marker survives in recent output after startup mouse-mode escapes expire.
    const appMarker = term.parser.registerOscHandler(7501, data => {
      if (/(?:^|[:;])app=codex(?:$|[:;])/.test(data)) detectedCodex = true;
      return false;
    });
    const appExit = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
      if (params.some(value => [47, 1047, 1049].includes(value))) detectedCodex = false;
      return false;
    });
    const unbindScroll = bindTerminalScrolling(term, { isCodex });
    const selection = term.onSelectionChange(() => { setHasSelection(term.hasSelection()); setCopyStatus(''); });
    const onData = term.onData(data => { if (activeRef.current && !replaying && socketRef.current?.readyState === WebSocket.OPEN) for (const chunk of terminalInputChunks(data)) socketRef.current.send(JSON.stringify({ type: 'terminal/input', id: terminal.id, data: chunk })); });
    function synchronizeSize({ cols = term.cols, rows = term.rows } = {}) {
      if (activeRef.current && !replaying && socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'terminal/resize', id: terminal.id, cols, rows }));
    }
    const onResize = term.onResize(synchronizeSize);
    function scheduleFit(synchronize = false) {
      if (disposed || replaying || !activeRef.current) return;
      synchronizeAfterFit ||= synchronize === true;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!disposed && !replaying && activeRef.current && container.current?.clientWidth && container.current?.clientHeight) {
          const { cols, rows } = term;
          fit.fit();
          // Another browser may have resized the shared PTY even when this view's geometry is unchanged.
          if (synchronizeAfterFit && term.cols === cols && term.rows === rows) synchronizeSize();
          synchronizeAfterFit = false;
        }
      });
    }
    scheduleFitRef.current = () => scheduleFit(true);
    function replay(geometry = terminalInfoRef.current) {
      const version = ++replayVersion;
      nativeSelectionRef.current = ''; setNativeSelectionText('');
      replaying = true; setReady(false);
      // Reset after earlier queued writes; keep replay and live output in order.
      term.write('', () => {
        if (disposed) return;
        detectedCodex = false;
        term.reset();
        // Interpret the snapshot at the PTY's dimensions before fitting our own viewport.
        if (Number.isInteger(geometry.cols) && geometry.cols > 0 && Number.isInteger(geometry.rows) && geometry.rows > 0) term.resize(geometry.cols, geometry.rows);
      });
      const output = terminalBuffers.get(terminal.id) || '';
      writeTerminalOutput(term, output, () => {
        if (disposed || version !== replayVersion) return;
        const finish = () => { if (disposed || version !== replayVersion) return; replaying = false; setReady(true); scheduleFit(true); };
        // Fullscreen Codex redraws in place. A capped replay loses its startup
        // mouse modes; restore them so native drag/copy works after reconnect.
        if (isCodex() && output.length >= 2 * 1024 * 1024 && term.modes.mouseTrackingMode === 'none' && term.buffer.active.baseY === 0) {
          term.write('\x1b[?1003h\x1b[?1006h', finish);
        } else finish();
      });
    }
    replay();
    function update(event) {
      if (event.detail.id !== terminal.id) return;
      if (event.detail.reset) replay(event.detail);
      else writeTerminalOutput(term, event.detail.data);
    }
    terminalBus.addEventListener('output', update);
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(container.current);
    function restoreSize() { if (document.visibilityState === 'visible') scheduleFit(true); }
    window.addEventListener('focus', restoreSize);
    document.addEventListener('visibilitychange', restoreSize);
    return () => { disposed = true; cancelAnimationFrame(frame); scheduleFitRef.current = null; termRef.current = null; fitRef.current = null; observer.disconnect(); window.removeEventListener('focus', restoreSize); document.removeEventListener('visibilitychange', restoreSize); terminalBus.removeEventListener('output', update); unbindScroll(); unbindDirectCopy(); unbindNativeCopy(); appMarker.dispose(); appExit.dispose(); fileLinks.dispose(); oscLinks.dispose(); selection.dispose(); onData.dispose(); onResize.dispose(); term.dispose(); };
  }, [terminal.id, initialized]);
  useEffect(() => {
    if (!active || !ready) return;
    scheduleFitRef.current?.();
    if (!window.matchMedia('(pointer: coarse)').matches) termRef.current?.focus();
  }, [active, ready]);
  return <section className={`terminal-view ${active ? 'visible' : ''}`} aria-label={terminalLabel(terminal.title)} aria-busy={!ready} onPasteCapture={event => { if (event.clipboardData.files.length) { event.preventDefault(); event.stopPropagation(); onUpload(event.clipboardData.files); } }}><div className="terminal-caption"><span><TerminalSquare size={14} />{terminalLabel(terminal.title)}</span><div className="terminal-copy-tools"><span className="terminal-copy-hint">{/Mac/.test(navigator.platform) ? '拖动选择 · ⌘C / 右键复制' : '拖动选择 · Ctrl+C / 右键复制'}</span><span role="status">{copyStatus}</span><button type="button" className="terminal-upload-toggle" aria-label="终端上传附件" aria-haspopup="menu" aria-expanded={!!uploadMenu} disabled={!connected} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); setUploadMenu(uploadMenu ? null : { left: Math.max(8, Math.min(bounds.left, window.innerWidth - 202)), top: bounds.bottom + 6 }); }}><Paperclip size={14} />上传</button><button type="button" className="terminal-download-toggle" aria-label="终端下载文件" aria-haspopup="dialog" disabled={!ready || !connected} onMouseDown={event => event.preventDefault()} onClick={() => openDownloads()}><Download size={14} />下载</button><button type="button" aria-label="复制选中内容" disabled={!hasSelection && !nativeSelectionText} onMouseDown={event => event.preventDefault()} onClick={copySelection}><Copy size={13} />复制</button><button type="button" className="terminal-keyboard-toggle" aria-label={keyboardOpen ? '收起终端键盘' : '显示终端键盘'} aria-expanded={keyboardOpen} onPointerDown={event => event.preventDefault()} onClick={() => setKeyboardOpen(value => !value)}><Keyboard size={14} />按键</button><span>{terminal.exited ? `已退出 · ${terminal.exitCode}` : terminal.isDefault ? 'Codex CLI' : '本机 Shell'}</span></div></div>{uploadMenu && <><div className="menu-dismiss" onClick={() => setUploadMenu(null)} /><div className="add-menu terminal-upload-menu" role="menu" aria-label="终端上传" style={uploadMenu}>{files.length > 0 && <button type="button" role="menuitem" aria-label="查看已上传附件" onClick={() => { setUploadMenu(null); setFilesHidden(false); setFilesExpanded(true); }}><FolderOpen size={16} />查看已上传附件<span className="terminal-upload-menu-count">{files.length}</span></button>}<button type="button" role="menuitem" onClick={() => { setUploadMenu(null); terminalFileInput.current?.click(); }}><Paperclip size={16} />添加文件</button><button type="button" role="menuitem" onClick={() => { setUploadMenu(null); terminalFolderInput.current?.click(); }}><Folder size={16} />添加文件夹</button>{window.matchMedia('(pointer: coarse)').matches && <button type="button" role="menuitem" onClick={() => { setUploadMenu(null); cameraInput.current?.click(); }}><Image size={16} />拍照上传</button>}</div></>}
    <input ref={terminalFileInput} type="file" multiple className="visually-hidden" aria-label="选择终端上传文件" onChange={event => { onUpload(event.target.files); event.target.value = ''; }} />
    {downloadDialog && <TerminalDownloads terminal={terminal} initialPath={downloadDialog.path} paths={downloadDialog.paths} onClose={() => setDownloadDialog(null)} />}
    <input ref={terminalFolderInput} type="file" webkitdirectory="" directory="" multiple className="visually-hidden" aria-label="选择终端上传文件夹" onChange={event => { onUpload(folderFromFiles(event.target.files)); event.target.value = ''; }} />
    <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="visually-hidden" aria-label="终端拍照上传" onChange={event => { onUpload(event.target.files); event.target.value = ''; }} />
    <div className="terminal-screen"><div className="terminal-container" ref={container} />{!ready && <div className="terminal-loading" role="status"><LoaderCircle size={16} className="spin" />正在恢复终端…</div>}</div>
    {files.length > 0 && !filesHidden && <section className="terminal-upload-panel" aria-label="终端附件"><header><button type="button" aria-label={filesExpanded ? '收起终端附件' : '展开终端附件'} aria-expanded={filesExpanded} onClick={() => setFilesExpanded(value => !value)}><Paperclip size={12} /><span>附件 · {files.length}</span><small>{files.some(file => file.status === 'uploading') ? '上传中…' : files.some(file => file.status === 'error') ? '有文件上传失败' : '已上传'}</small><ChevronDown size={12} style={{ transform: filesExpanded ? 'rotate(180deg)' : undefined }} /></button><div className="terminal-upload-actions"><button type="button" className="terminal-insert-all" disabled={!ready || !connected || terminal.exited || !files.some(file => file.status === 'done')} onClick={() => insertPaths(files)}>插入全部路径</button><button type="button" className="terminal-upload-close" aria-label="关闭终端附件面板" title="关闭附件面板" onClick={() => setFilesHidden(true)}><X size={16} /></button></div></header>{filesExpanded && <div className="terminal-upload-list">{files.map(file => <UploadCard key={file.id} file={file} onRemove={() => onRemove(file)} onRetry={() => onRetry(file)} insertDisabled={!ready || !connected || terminal.exited} onInsert={() => insertPaths([file])} />)}</div>}{filesExpanded && <p className="terminal-upload-note" role="status">{uploadStatus || '上传完成后，插入路径并按回车提交'}</p>}</section>}
    <div className="terminal-keyboard-host" hidden={!keyboardOpen}><TerminalKeyboard terminalRef={termRef} disabled={!active || !ready || !connected || terminal.exited} /></div>{terminal.exited && <div className="terminal-exited">{terminal.isDefault ? <button onClick={onRestart}>重新打开 Codex</button> : '此终端已退出，点击「＋」可新建终端。'}</div>}</section>;
}

function App() {
  const [auth, setAuth] = useState(null);
  const [conversations, setConversations] = useState([]);
  const conversationStateRef = useRef(new Map());
  const taskDraftsRef = useRef(null);
  taskDraftsRef.current ||= savedTaskDrafts();
  const [pendingDraft, updatePendingDraft] = useState(() => taskDraftsRef.current[localStorage.getItem('mono-active-workspace')] || null);
  const pendingDraftRef = useRef(pendingDraft); pendingDraftRef.current = pendingDraft;
  function persistTaskDrafts() {
    try { localStorage.setItem('mono-task-drafts', JSON.stringify(taskDraftsRef.current)); } catch { /* Storage may be unavailable. */ }
  }
  function setPendingDraft(value) {
    const next = typeof value === 'function' ? value(pendingDraftRef.current) : value;
    pendingDraftRef.current = next;
    if (next) { taskDraftsRef.current[next.workspaceId] = next; persistTaskDrafts(); }
    updatePendingDraft(next);
  }
  const [terminals, setTerminals] = useState([]);
  const [activeId, setActiveId] = useState(localStorage.getItem('mono-active-chat'));
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId;
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('mono-active-tab') || 'chat');
  const [chatOpened, setChatOpened] = useState(activeTab === 'chat');
  useEffect(() => { if (activeTab === 'chat') setChatOpened(true); }, [activeTab]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(localStorage.getItem('mono-active-workspace'));
  const [config, setConfig] = useState({ workspace: '', codexStatus: 'starting' });
  const [connection, setConnection] = useState('connecting');
  const [approvals, setApprovals] = useState([]);
  const [drafts, setDrafts] = useState(savedDrafts);
  const [menu, setMenu] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [usageStatsOpen, setUsageStatsOpen] = useState(false);
  const [resourceOpen, setResourceOpen] = useState(false);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [readingDrop, setReadingDrop] = useState(false);
  const [sidebar, setSidebar] = useState(window.innerWidth > 760);
  const [terminalToClose, setTerminalToClose] = useState(null);
  const [closingTerminal, setClosingTerminal] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const messageInFlight = useRef(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [commandDialog, setCommandDialog] = useState(null);
  const [selectorRequest, setSelectorRequest] = useState(null);
  const [notice, setNotice] = useState('');
  const slashRef = useRef(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const socketRef = useRef(null);
  const outputSpeedTracker = useRef(null);
  outputSpeedTracker.current ||= new OutputSpeedTracker(localStorage);
  const sessionStatsTracker = useRef(null);
  sessionStatsTracker.current ||= new SessionStatsTracker();
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const textInput = useRef(null);
  const messageList = useRef(null);
  const messageContent = useRef(null);
  const dragDepth = useRef(0);
  const uploads = useRef(new Map());
  const draftTargets = useRef(new Map());
  const activeWorkspaceRef = useRef(activeWorkspaceId);
  activeWorkspaceRef.current = activeWorkspaceId;
  const nearBottomRef = useRef(true);
  const workspace = config.workspaces?.find(w => w.id === activeWorkspaceId) || config.workspaces?.find(w => w.id === config.defaultWorkspaceId);
  const workspaceId = workspace?.id;
  const conversation = pendingDraft?.id === activeId && pendingDraft.workspaceId === workspaceId ? pendingDraft
    : conversations.find(c => c.id === activeId && c.workspaceId === workspaceId) || conversations.find(c => c.workspaceId === workspaceId && !c.archivedAt);
  const visibleTerminals = terminals.filter(t => t.workspaceId === workspaceId);
  const chatId = conversation?.id;
  const draft = drafts[chatId] || { text: '', files: [] };
  const leaseTarget = activeTab === 'chat' ? chatId : terminalDraftKey(terminals.find(t => t.id === activeTab));
  const leaseIds = JSON.stringify((drafts[leaseTarget]?.files || []).filter(file => file.status === 'done').map(file => file.server?.id || file.id));
  const working = conversation?.status === 'active' || !!conversation?.activeTurnId || submitting;
  const requests = approvals.filter(a => a.params.threadId === conversation?.threadId);
  const connected = connection === 'connected';

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      if (viewport && viewport.scale !== 1) return;
      const height = viewport?.height || window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${height}px`);
      document.documentElement.dataset.compactViewport = String(height < 500);
    };
    update();
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update); window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--app-height'); delete document.documentElement.dataset.compactViewport;
    };
  }, []);
  useEffect(() => { fetch('/api/auth').then(r => r.json()).then(data => setAuth(data.authenticated)).catch(() => setError('无法连接服务器，请刷新重试')); }, []);
  useEffect(() => { if (auth === true) return startResourceMonitoring(); }, [auth]);
  useEffect(() => {
    if (!auth) return;
    let disposed = false, timer, stableTimer, retry = 0;
    function connect() {
      if (disposed) return;
      setConnection('connecting');
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socketRef.current = ws;
      ws.onopen = () => {
        setConnection('connected');
        ws.send(JSON.stringify({ type: 'client/hello', conversationPatches: true }));
        stableTimer = setTimeout(() => { retry = 0; }, 30000);
      };
      ws.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot') {
          conversationStateRef.current = new Map(data.conversations.map(c => [c.id, c]));
          const observedConversations = data.conversations.map(c => {
            const now = performance.now();
            return sessionStatsTracker.current.observe(outputSpeedTracker.current.observe(c, now, true), now, true);
          });
          setConfig(data); setConversations(observedConversations); setTerminals(data.terminals); setApprovals(data.approvals);
          const selectedWorkspace = data.workspaces.some(w => w.id === activeWorkspaceRef.current) ? activeWorkspaceRef.current : data.defaultWorkspaceId;
          setActiveWorkspaceId(selectedWorkspace);
          const savedHere = data.conversations.find(c => c.workspaceId === selectedWorkspace && !c.archivedAt);
          const restoredDraft = taskDraftsRef.current[selectedWorkspace] || (!savedHere
            ? taskDraft(data.workspaces.find(w => w.id === selectedWorkspace), null, data.models?.find(model => model.isDefault)) : null);
          setPendingDraft(restoredDraft);
          setActiveId(previous => previous === restoredDraft?.id ? previous
            : data.conversations.some(c => c.id === previous && c.workspaceId === selectedWorkspace) ? previous : savedHere?.id || restoredDraft?.id);
          for (const t of data.terminals) {
            terminalBuffers.set(t.id, t.replay || '');
            terminalBus.dispatchEvent(new CustomEvent('output', { detail: { id: t.id, reset: true, cols: t.cols, rows: t.rows } }));
          }
          setActiveTab(previous => {
            if (previous === 'chat') return 'chat';
            if (previous === 'terminal:default') return data.terminals.find(t => t.isDefault && t.workspaceId === selectedWorkspace)?.id || 'chat';
            return data.terminals.some(t => t.id === previous && t.workspaceId === selectedWorkspace) ? previous : 'chat';
          });
        } else if (data.type === 'conversation' || data.type === 'conversation/updated') {
          const incoming = data.type === 'conversation/updated' ? mergeConversationPatch(conversationStateRef.current.get(data.conversation.id), data) : data.conversation;
          conversationStateRef.current.set(incoming.id, incoming);
          const now = performance.now();
          const observed = sessionStatsTracker.current.observe(outputSpeedTracker.current.observe(incoming, now), now);
          setConversations(previous => upsert(previous, observed));
        }
        else if (data.type === 'codex/status') setConfig(c => ({ ...c, codexStatus: data.status }));
        else if (data.type === 'workspaces') setConfig(c => ({ ...c, workspaces: data.workspaces }));
        else if (data.type === 'models') setConfig(c => ({ ...c, models: data.models, modelsError: data.modelsError }));
        else if (data.type === 'approvals') setApprovals(data.approvals);
        else if (data.type === 'terminal/created' || data.type === 'terminal/update') setTerminals(previous => upsert(previous, data.terminal));
        else if (data.type === 'terminal/deleted') {
          setTerminals(previous => previous.filter(t => t.id !== data.id));
          setActiveTab(previous => previous === data.id ? 'chat' : previous);
          terminalBuffers.delete(data.id);
        } else if (data.type === 'terminal/reset') {
          terminalBuffers.set(data.id, '');
          terminalBus.dispatchEvent(new CustomEvent('output', { detail: { id: data.id, reset: true } }));
        } else if (data.type === 'terminal/data') {
          terminalBuffers.set(data.id, ((terminalBuffers.get(data.id) || '') + data.data).slice(-2 * 1024 * 1024));
          terminalBus.dispatchEvent(new CustomEvent('output', { detail: data }));
        }
      };
      ws.onclose = event => {
        clearTimeout(stableTimer);
        if (disposed) return;
        setConnection('disconnected');
        fetch('/api/auth').then(r => r.json()).then(a => { if (!a.authenticated) setAuth(false); }).catch(() => {});
        timer = setTimeout(connect, reconnectDelay(retry++, event.code));
      };
      ws.onerror = () => {};
    }
    connect();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(stableTimer); socketRef.current?.close(); };
  }, [auth]);
  useEffect(() => {
    const selectedTerminal = terminals.find(terminal => terminal.id === activeTab);
    localStorage.setItem('mono-active-tab', selectedTerminal?.isDefault ? 'terminal:default' : activeTab);
  }, [activeTab, terminals]);
  useEffect(() => {
    if (!workspaceId) return;
    localStorage.setItem('mono-active-workspace', workspaceId);
    if (chatId) {
      localStorage.setItem('mono-active-chat', chatId);
      let remembered = {};
      try { remembered = JSON.parse(localStorage.getItem('mono-workspace-chats') || '{}'); } catch {}
      localStorage.setItem('mono-workspace-chats', JSON.stringify({ ...remembered, [workspaceId]: chatId }));
    }
  }, [chatId, workspaceId, conversation?.isDraft]);
  useEffect(() => {
    // Keep only completed attachment metadata; browser File objects do not survive refresh.
    const saved = Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [id, {
      text: draft.text,
      skills: draft.skills || [],
      files: draft.files.filter(f => f.status === 'done').map(file => ({ id: file.id, name: file.name, size: file.size, kind: file.kind, status: 'done', progress: 100, server: file.server, preview: file.server.image ? file.server.url : null })),
    }]));
    try { localStorage.setItem('mono-drafts', JSON.stringify(saved)); } catch { /* Storage may be disabled. */ }
  }, [drafts]);
  useEffect(() => {
    if (!auth || !connected) return;
    const target = leaseTarget;
    const ids = JSON.parse(leaseIds);
    if (!ids.length) return;
    const keep = () => {
      if (document.visibilityState === 'hidden') return;
      for (let index = 0; index < ids.length; index += 1000) {
        api('/api/uploads/keepalive', { ids: ids.slice(index, index + 1000) }).then(result => {
          if (!result.missing?.length) return;
          const missing = new Set(result.missing);
          setDrafts(previous => {
            const current = previous[target];
            if (!current) return previous;
            return { ...previous, [target]: { ...current, files: current.files.map(file =>
              missing.has(file.server?.id || file.id) ? { ...file, status: 'error', error: '未使用附件已过期，请移除后重新上传' } : file) } };
          });
        }).catch(() => {});
      }
    };
    keep();
    const timer = setInterval(keep, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', keep);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', keep); };
  }, [auth, connected, leaseTarget, leaseIds]);
  useEffect(() => { if (error) { const timer = setTimeout(() => setError(''), 6500); return () => clearTimeout(timer); } }, [error]);
  const scrollToLatest = useChatScroll({ scrollerRef: messageList, contentRef: messageContent, followRef: nearBottomRef,
    conversationId: chatId, visible: auth === true && activeTab === 'chat' && chatOpened,
    contentVersion: conversation, onNearBottom: setNearBottom });
  useEffect(() => {
    if (textInput.current) { textInput.current.style.height = 'auto'; textInput.current.style.height = `${Math.min(textInput.current.scrollHeight, 180)}px`; }
  }, [draft.text, chatId]);

  function updateDraft(id, update) {
    const targetId = draftTargets.current.get(id) || id;
    setDrafts(previous => ({ ...previous, [targetId]: update(previous[targetId] || { text: '', files: [] }) }));
  }
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); } }, [notice]);
  async function changeSettings(patch) {
    setSettingsBusy(true);
    try {
      if (conversation?.isDraft) {
        const settings = validateSettings(conversation, patch, config.models);
        const updated = { ...conversation, ...settings };
        setPendingDraft(updated); return updated;
      }
      const updated = await api(`/api/conversations/${chatId}/settings`, patch, 'PATCH');
      setConversations(previous => upsert(previous, updated));
      return updated;
    } catch (error) { setError(error.message); return null; }
    finally { setSettingsBusy(false); }
  }
  async function refreshModels() {
    try { const result = await api('/api/models', undefined, 'GET'); setConfig(c => ({ ...c, models: result.models, modelsError: null })); }
    catch (error) { setError(error.message); }
  }
  async function newConversation(targetWorkspaceId = workspaceId) {
    setMenu(false); setCreating(true);
    const targetWorkspace = config.workspaces?.find(item => item.id === targetWorkspaceId) || workspace;
    if (!targetWorkspace) { setCreating(false); return; }
    const template = conversation?.workspaceId === targetWorkspaceId ? conversation : conversations.find(item => item.workspaceId === targetWorkspaceId);
    const draft = taskDraftsRef.current[targetWorkspaceId] || taskDraft(targetWorkspace, template, config.models?.find(model => model.isDefault));
    setPendingDraft(draft); setActiveWorkspaceId(targetWorkspaceId); setActiveId(draft.id); setActiveTab('chat');
    if (window.innerWidth < 761) setSidebar(false);
    setCreating(false);
    requestAnimationFrame(() => textInput.current?.focus());
    return draft;
  }
  async function selectWorkspace(id) {
    if (id === workspaceId) return;
    let remembered;
    try { remembered = JSON.parse(localStorage.getItem('mono-workspace-chats') || '{}')[id]; } catch {}
    const pending = taskDraftsRef.current[id];
    const selected = (pending?.id === remembered ? pending : null) || conversations.find(c => c.id === remembered && c.workspaceId === id && !c.archivedAt)
      || conversations.filter(c => c.workspaceId === id && !c.archivedAt).sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))[0];
    setPendingDraft(pending || null); setActiveWorkspaceId(id); setActiveTab('chat'); setActiveId(selected?.id || null);
    if (selected) { if (window.innerWidth < 761) setSidebar(false); }
    else { try { await newConversation(id); } catch {} }
  }
  async function openHistory(key) {
    const { conversation: selected, workspace: selectedWorkspace } = await api('/api/history/open', { key });
    setConfig(previous => ({ ...previous, workspaces: upsert(previous.workspaces || [], selectedWorkspace) }));
    setConversations(previous => upsert(previous, selected));
    setPendingDraft(null); setActiveWorkspaceId(selected.workspaceId); setActiveId(selected.id); setActiveTab('chat');
    if (window.innerWidth < 761) setSidebar(false);
  }
  useEffect(() => {
    if (!connected || !conversation?.nativeHistory) return;
    let disposed = false;
    api('/api/history/open', { key: chatId }).then(({ conversation: updated }) => {
      if (!disposed) setConversations(previous => upsert(previous, updated));
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; };
  }, [chatId, connected]);
  async function addWorkspace(selected) {
    setConfig(previous => ({ ...previous, workspaces: upsert(previous.workspaces || [], selected) }));
    await selectWorkspace(selected.id);
  }
  async function patchConversation(id, patch) {
    try { const c = await api(`/api/conversations/${id}`, patch, 'PATCH'); setConversations(previous => upsert(previous, c)); return c; }
    catch (error) { setError(error.message); throw error; }
  }
  async function newTerminal(codex = false) {
    setMenu(false);
    try { const t = await api(codex ? '/api/terminals/default' : '/api/terminals', { workspaceId }); setTerminals(previous => upsert(previous, t)); setActiveTab(t.id); }
    catch (error) { setError(error.message); }
  }
  async function closeTerminal(id) {
    setClosingTerminal(true);
    setTerminalToClose(previous => previous ? { ...previous, error: '' } : previous);
    try {
      await api(`/api/terminals/${id}`, undefined, 'DELETE');
      setTerminals(previous => previous.filter(t => t.id !== id));
      setActiveTab(previous => previous === id ? 'chat' : previous);
      setTerminalToClose(null);
    } catch (error) {
      setTerminalToClose(previous => previous ? { ...previous, error: error.message } : previous);
      setError(error.message);
    }
    finally { setClosingTerminal(false); }
  }
  function requestCloseTerminal(terminal) {
    if (terminal.exited) closeTerminal(terminal.id);
    else setTerminalToClose(terminal);
  }
  function suggestTask(text) {
    if (!chatId || conversation?.archivedAt) return;
    updateDraft(chatId, current => ({ ...current, text: current.text.trim() ? `${current.text}\n\n${text}` : text }));
    textInput.current?.focus();
  }
  function openSearch() {
    setSidebar(true);
    requestAnimationFrame(() => window.dispatchEvent(new Event('workspace:search')));
  }
  function selectChat(id) {
    const c = conversations.find(c => c.id === id);
    if (!c) return;
    setPendingDraft(null); setActiveWorkspaceId(c.workspaceId); setActiveId(id); setActiveTab('chat');
    if (window.innerWidth < 761) setSidebar(false);
  }
  function patchFile(id, fileId, patch) { updateDraft(id, d => ({ ...d, files: d.files.map(f => f.id === fileId ? { ...f, ...patch } : f) })); }
  async function uploadFile(id, file) {
    if (uploads.current.has(file.id)) return;
    const controller = new AbortController();
    uploads.current.set(file.id, controller);
    patchFile(id, file.id, { status: 'uploading', progress: 0, speed: null, error: null });
    let transferred = 0;
    let lastProgressTime = 0, lastProgress = -1;
    const samples = [{ time: performance.now(), bytes: 0 }];
    const speedTimer = setInterval(() => {
      const now = performance.now();
      samples.push({ time: now, bytes: transferred });
      while (samples.length > 2 && samples[1].time <= now - 2000) samples.shift();
      const elapsed = now - samples[0].time;
      patchFile(id, file.id, { speed: elapsed > 0 ? (transferred - samples[0].bytes) * 1000 / elapsed : 0 });
    }, 500);
    try {
      const server = await (file.kind === 'folder' ? sendFolder : sendFile)(file, {
        signal: controller.signal,
        onTransfer: bytes => { transferred += bytes; },
        onProgress: loaded => {
          const progress = file.size ? Math.min(99, loaded / file.size * 100) : 99;
          const now = performance.now();
          if (progress === lastProgress || progress < 99 && now - lastProgressTime < 100) return;
          lastProgressTime = now; lastProgress = progress;
          patchFile(id, file.id, { progress });
        },
      });
      patchFile(id, file.id, { status: 'done', progress: 100, speed: null, server });
    } catch (error) {
      if (error.name !== 'AbortError') patchFile(id, file.id, { status: 'error', speed: null, error: error.message });
    } finally { clearInterval(speedTimer); uploads.current.delete(file.id); }
  }
  function addFiles(incoming, targetId = chatId) {
    if (!targetId) return setError('请等待 Codex 工作区就绪');
    if (conversations.find(c => c.id === targetId)?.archivedAt) return setError('请先恢复归档的对话，再添加附件');
    const terminalTarget = terminals.some(terminal => terminalDraftKey(terminal) === targetId);
    if (targetId.startsWith('terminal:') && !terminalTarget) return setError('此终端已关闭，请重新选择终端');
    if (!terminalTarget && (drafts[targetId]?.files.length || 0) + incoming.length > 20) return setError('每条消息最多添加 20 个附件，文件夹算一个附件');
    const files = Array.from(incoming).map(value => {
      const file = value.raw || value.kind === 'folder' ? value : { id: uploadId(), raw: value, name: value.name, size: value.size };
      return { ...file, preview: file.raw?.type.startsWith('image/') ? URL.createObjectURL(file.raw) : null,
        progress: 0, status: 'uploading', error: null };
    });
    updateDraft(targetId, d => ({ ...d, files: [...d.files, ...files] }));
    for (const file of files) uploadFile(targetId, file);
  }
  function removeFile(file, targetId = chatId) {
    uploads.current.get(file.id)?.abort();
    const ids = [file.id, ...(file.files || []).map(child => child.id)];
    for (const id of ids) fetch(`/api/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
    if (file.preview) URL.revokeObjectURL(file.preview);
    updateDraft(targetId, d => ({ ...d, files: d.files.filter(f => f.id !== file.id) }));
  }
  async function goalAction(operation, values = {}) {
    setGoalBusy(true);
    const selectedId = chatId;
    try {
      const result = await api(`/api/conversations/${selectedId}/goal`, operation ? { operation, ...values } : undefined, operation ? 'POST' : 'GET');
      setConversations(previous => previous.map(item => item.id === selectedId ? { ...item, goal: result.goal } : item));
      return result;
    } finally { setGoalBusy(false); }
  }
  async function openGoal() {
    setGoalOpen(true);
    try { await goalAction(); } catch (error) { setError(error.message); }
  }
  useEffect(() => { setGoalOpen(false); }, [chatId]);
  async function executeSlash(id, argument = '') {
    const command = slashCommands.find(item => item.id === id);
    if (!command) { setError('未知命令，输入 /help 查看可用命令'); return; }
    if (working && command.idle || commandBusy || settingsBusy) { setError('请等待当前操作完成'); return; }
    if (conversation?.isDraft && !['new', 'resume', 'status', 'help', 'model', 'effort', 'permissions', 'fast', 'plan', 'init'].includes(id)) {
      setError('开始任务后才能使用此命令'); return;
    }
    const originId = chatId, originalText = draft.text;
    setCommandBusy(true); setError('');
    try {
      let updated = true;
      if (id === 'new') await newConversation();
      else if (id === 'resume') setHistoryOpen(true);
      else if (id === 'goal') {
        if (!argument || argument === 'status') await openGoal();
        else if (['pause', 'resume', 'clear'].includes(argument)) await goalAction(argument);
        else if (/^budget(?:\s|$)/.test(argument)) {
          const value = argument.slice(6).trim();
          if (!value) throw new Error('用法：/goal budget 数量，或 /goal budget none 取消预算');
          const tokenBudget = value === 'none' ? null : Number(value);
          if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) throw new Error('Token 预算必须是正整数');
          await goalAction('budget', { tokenBudget });
        } else await goalAction('create', { objective: argument, tokenBudget: null });
      }
      else if (['status', 'help'].includes(id)) setCommandDialog({ kind: id });
      else if (id === 'rename') {
        if (argument) await patchConversation(chatId, { title: argument }); else setCommandDialog({ kind: 'rename' });
      } else if (id === 'archive') await patchConversation(chatId, { archived: true });
      else if (id === 'stop') await stop();
      else if (['model', 'effort', 'permissions'].includes(id)) {
        if (!argument) setSelectorRequest({ kind: id === 'permissions' ? 'permission' : id, nonce: Date.now() });
        else updated = await changeSettings({ [id === 'permissions' ? 'permissionMode' : id]: ({ full: 'full-access', readonly: 'read-only', default: 'workspace-write' })[argument] || argument });
      } else if (id === 'fast' || id === 'plan') {
        if (argument && !['on', 'off'].includes(argument)) throw new Error(`用法：/${id} on 或 /${id} off`);
        const enabled = argument ? argument === 'on' : id === 'fast' ? !conversation.fast : conversation.mode !== 'plan';
        updated = await changeSettings(id === 'fast' ? { fast: enabled } : { mode: enabled ? 'plan' : 'default' });
      } else if (id === 'init') {
        updated = await sendMessage(undefined, '请检查当前项目，并创建或更新 AGENTS.md，记录准确的项目结构、开发规范以及构建和测试命令。');
      } else {
        if (['skills', 'diff'].includes(id)) setCommandDialog({ kind: 'loading', title: id === 'skills' ? '选择技能' : '工作区差异' });
        const result = await api(`/api/conversations/${chatId}/actions`, { action: id, argument });
        if (id === 'fork') { setConversations(previous => upsert(previous, result.conversation)); setActiveId(result.conversation.id); setActiveTab('chat'); }
        else if (id === 'diff') setCommandDialog({ kind: 'diff', text: result.diff });
        else if (id === 'skills') setCommandDialog({ kind: 'skills', skills: [...new Map((result.data || []).flatMap(entry => entry.skills || []).map(skill => [skill.path, skill])).values()] });
        else if (result.message) setNotice(result.message);
      }
      if (updated) updateDraft(originId, value => ({ ...value, text: value.text === originalText ? '' : value.text }));
    } catch (error) { setError(error.message); setCommandDialog(current => current?.kind === 'loading' ? null : current); }
    finally { setCommandBusy(false); textInput.current?.focus(); }
  }
  async function sendMessage(event, overrideText) {
    event?.preventDefault();
    if (overrideText === undefined) {
      const parsed = parseSlash(draft.text);
      if (parsed) { await executeSlash(parsed.command?.id || parsed.name, parsed.argument); return; }
    }
    if (!chatId || conversation?.archivedAt || messageInFlight.current || submitting || settingsBusy || commandBusy && overrideText === undefined || !connected || config.codexStatus !== 'ready' || draft.files.some(f => f.status !== 'done') || (!draft.text.trim() && !draft.files.length)) return;
    messageInFlight.current = true;
    setSubmitting(true); setError(''); scrollToLatest();
    const requestStartedAt = performance.now();
    if (!conversation.isDraft && !working) {
      sessionStatsTracker.current.request(conversation, requestStartedAt);
      const observed = outputSpeedTracker.current.startExisting(conversation, requestStartedAt);
      setConversations(previous => upsert(previous, observed));
    }
    const submitted = { ...draft, text: overrideText ?? draft.text };
    try {
      const message = { text: submitted.text, attachments: submitted.files.map(f => f.server.id), skills: (submitted.skills || []).filter(skill => submitted.text.split(/\s+/).includes(`$${skill.name}`)) };
      let targetId = chatId;
      if (conversation.isDraft) {
        const result = await api('/api/tasks', { ...message, workspaceId: conversation.workspaceId, model: conversation.model, effort: conversation.effort,
          permissionMode: conversation.permissionMode, fast: conversation.fast, mode: conversation.mode });
        targetId = result.conversation.id;
        sessionStatsTracker.current.request(result.conversation, requestStartedAt);
        const observed = sessionStatsTracker.current.observe(outputSpeedTracker.current.startNew(result.conversation, requestStartedAt), performance.now());
        setConversations(previous => upsert(previous, observed));
        delete taskDraftsRef.current[conversation.workspaceId]; persistTaskDrafts();
        if (pendingDraftRef.current?.id === chatId) setPendingDraft(null);
        if (activeIdRef.current === chatId) setActiveId(targetId);
        draftTargets.current.set(chatId, targetId);
        setDrafts(previous => {
          const current = previous[chatId] || submitted;
          const next = { ...previous, [targetId]: { ...current,
            text: current.text === submitted.text ? '' : current.text,
            files: current.files.filter(file => !submitted.files.some(sent => sent.id === file.id)),
          } };
          delete next[chatId]; return next;
        });
      } else {
        await api(`/api/conversations/${chatId}/messages`, message);
        updateDraft(chatId, d => ({ ...d, text: d.text === submitted.text ? '' : d.text, skills: [], files: d.files.filter(f => !submitted.files.some(s => s.id === f.id)) }));
      }
      submitted.files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
      return true;
    } catch (error) { setError(error.message); return false; }
    finally { messageInFlight.current = false; setSubmitting(false); textInput.current?.focus(); }
  }
  async function stop() { try { await api(`/api/conversations/${chatId}/interrupt`, {}); } catch (error) { setError(error.message); } }
  useEffect(() => {
    const shortcut = event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        if (document.querySelector('[role="dialog"]') || event.target.closest?.('.terminal-view')) return;
        event.preventDefault(); openSearch(); return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'n') return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); newConversation().catch(() => {});
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [workspaceId, conversation, config.models, config.workspaces]);
  useEffect(() => {
    const dismiss = event => {
      if (event.key !== 'Escape') return;
      setMenu(false); setAttachmentMenu(false);
      if (window.innerWidth < 761 && !document.querySelector('[role="dialog"], [role="menu"], .search-field')) setSidebar(false);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, []);
  function drag(event, type) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (type === 'enter') { dragDepth.current++; setDragging(true); }
    if (type === 'leave' && --dragDepth.current <= 0) { setDragging(false); dragDepth.current = 0; }
    if (type === 'over') event.dataTransfer.dropEffect = 'copy';
    if (type === 'drop') {
      dragDepth.current = 0; setDragging(false); setReadingDrop(true);
      const targetId = activeTab === 'chat' ? chatId : terminalDraftKey(terminals.find(terminal => terminal.id === activeTab));
      droppedFiles(event.dataTransfer).then(files => addFiles(files, targetId))
        .catch(() => setError('无法读取文件夹，请确认它已保存在本机，并允许浏览器访问'))
        .finally(() => setReadingDrop(false));
    }
  }

  if (auth === false) return <Login onSuccess={() => setAuth(true)} />;
  if (auth === null) return <div className="boot-screen"><Mark large /><span>正在连接本地工作区…</span>{error && <p>{error}</p>}</div>;
  const canSend = connected && config.codexStatus === 'ready' && !submitting && !conversation?.archivedAt && !settingsBusy && !commandBusy && !!(draft.text.trim() || draft.files.length) && !draft.files.some(f => f.status !== 'done');
  const hasMessages = conversation?.turns.some(t => t.items.length > 0);
  const workspaceName = (activeTab !== 'chat' ? terminals.find(t => t.id === activeTab)?.cwd?.split('/').filter(Boolean).pop() : null) || workspace?.name || 'Projects';
  return <div className={`app-shell ${sidebar ? 'sidebar-open' : 'sidebar-closed'} ${activeTab !== 'chat' ? 'terminal-active' : ''}`} onDragEnter={e => drag(e, 'enter')} onDragLeave={e => drag(e, 'leave')} onDragOver={e => drag(e, 'over')} onDrop={e => drag(e, 'drop')}>
    {sidebar && <Sidebar workspace={workspace} workspaces={config.workspaces || []} conversations={conversations}
      activeId={activeTab === 'chat' && !conversation?.isDraft ? chatId : null} connected={connected} ready={config.codexStatus === 'ready'} creating={creating}
      onClose={() => setSidebar(false)} onNew={() => { newConversation().catch(() => {}); }} onSelectChat={selectChat}
      onSelectWorkspace={selectWorkspace} onAddWorkspace={addWorkspace} onPatch={patchConversation} onHistory={() => setHistoryOpen(true)} onUsageStats={() => setUsageStatsOpen(true)} />}
    {!sidebar && <nav className="workspace-rail" aria-label="快捷导航">
      <button className="icon-button" aria-label="展开侧栏" title="展开侧栏" onClick={() => setSidebar(true)}><PanelLeftOpen size={19} /></button>
      <button className="icon-button" aria-label="新建任务" title="新建任务 · Ctrl+N" disabled={!connected || config.codexStatus !== 'ready'} onClick={() => newConversation().catch(() => {})}><SquarePen size={19} /></button>
      <button className="icon-button" aria-label="搜索对话" title="搜索对话 · Ctrl+K" onClick={openSearch}><Search size={19} /></button>
      <button className="icon-button rail-history" aria-label="全部历史" title="全部历史" onClick={() => setHistoryOpen(true)}><Archive size={18} /></button>
    </nav>}
    {terminalToClose && <Modal title="关闭终端" onClose={() => { if (!closingTerminal) setTerminalToClose(null); }} className="terminal-close-modal">
      <p>关闭「{terminalLabel(terminalToClose.title)}」会结束此终端中正在运行的进程。只想切换页面，可以保留终端并打开其他标签。</p>
      {terminalToClose.error && <div className="inline-error" role="alert">关闭失败：{terminalToClose.error}。可以重试，或取消并保留终端。</div>}
      <footer><button autoFocus disabled={closingTerminal} onClick={() => setTerminalToClose(null)}>取消</button><button className="danger-action" disabled={closingTerminal} onClick={() => closeTerminal(terminalToClose.id)}>{closingTerminal ? <LoaderCircle size={15} className="spin" /> : null}关闭终端</button></footer>
    </Modal>}
    {goalOpen && <GoalDialog key={chatId} goal={conversation?.goal} loading={goalBusy} working={working} onClose={() => setGoalOpen(false)} onAction={goalAction} />}
    {commandDialog && <CommandDialog key={commandDialog.kind} dialog={commandDialog} conversation={conversation} workspace={workspace} onClose={() => setCommandDialog(null)} onRename={title => patchConversation(chatId, { title })} onCommand={executeSlash} onSkill={skill => { updateDraft(chatId, value => ({ ...value, text: `$${skill.name} `, skills: [skill] })); setCommandDialog(null); textInput.current?.focus(); }} />}
    {resourceOpen && <ResourceManager onClose={() => setResourceOpen(false)} />}
    {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} onOpen={openHistory} />}
    {usageStatsOpen && <UsageStats onClose={() => setUsageStatsOpen(false)} />}
    <main className="main-panel">
      <header className="topbar"><div className="topbar-left">{!sidebar && <button className="icon-button mobile-sidebar-toggle" aria-label="展开侧栏" onClick={() => setSidebar(true)}><PanelLeftOpen size={17} /></button>}<span className="breadcrumb">{workspaceName}</span><ChevronRight size={12} /><span className="header-title">{activeTab === 'chat' ? conversation?.title || 'Codex' : terminalLabel(terminals.find(t => t.id === activeTab)?.title)}</span></div><div className="topbar-right"><span className={`workspace-status ${!connected ? 'offline' : requests.length ? 'waiting' : working ? 'running' : ''}`} role="status"><span />{!connected ? '重新连接中' : activeTab !== 'chat' ? (terminals.find(t => t.id === activeTab)?.exited ? '终端已退出' : '终端已连接') : requests.length ? '等待回答' : working ? '正在处理' : '就绪'}</span><button type="button" className="resource-manager-trigger" aria-label="资源管理器" title="资源管理器" aria-haspopup="dialog" onClick={() => setResourceOpen(true)}><Gauge size={16} /><span>资源管理器</span></button><span className="local-indicator"><span className="tiny-dot" />本地工作区</span>{activeTab === 'chat' && !conversation?.isDraft && <ConversationActions conversation={conversation} onPatch={patchConversation} header disabled={!connected || !chatId} />}</div></header>
      <div className="tabbar" role="tablist" aria-label="工作区标签" onKeyDown={event => {
        if (event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
        const index = tabs.indexOf(event.target);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.click(); tabs[next]?.focus();
      }}><button role="tab" tabIndex={activeTab === 'chat' ? 0 : -1} aria-selected={activeTab === 'chat'} className={`workspace-tab ${activeTab === 'chat' ? 'active' : ''}`} onClick={() => setActiveTab('chat')}><Mark />Codex</button>{visibleTerminals.map(t => <div key={t.id} className={`terminal-tab-wrapper ${activeTab === t.id ? 'active' : ''}`}><button role="tab" tabIndex={activeTab === t.id ? 0 : -1} aria-selected={activeTab === t.id} className="workspace-tab" onClick={() => setActiveTab(t.id)}><TerminalSquare size={14} />{terminalLabel(t.title)}</button><button className="close-tab" title="关闭终端" aria-label={`关闭 ${terminalLabel(t.title)}`} disabled={!connected || closingTerminal} onClick={() => requestCloseTerminal(t)}><X size={12} /></button></div>)}<div className="add-tab-container"><button className="add-tab icon-button" aria-label="新建标签页" title="新建任务或终端" aria-haspopup="menu" aria-expanded={!!menu} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); setMenu(menu ? false : { left: Math.min(bounds.left, window.innerWidth - 205), top: bounds.bottom + 7 }); }}><Plus size={17} /></button>{menu && <><div className="menu-dismiss" onClick={() => setMenu(false)} /><div className="add-menu" role="menu" aria-label="新建标签页" style={{ left: menu.left, top: menu.top }}><button onClick={() => { newConversation().catch(() => {}); }} disabled={creating || config.codexStatus !== 'ready'}><MessageCirclePlus size={16} /><span>新建任务</span><kbd>Ctrl+N</kbd></button><button onClick={() => newTerminal(true)} disabled={!connected}><TerminalSquare size={16} /><span>打开 Codex 终端</span></button><button onClick={() => newTerminal()} disabled={!connected}><TerminalSquare size={16} /><span>新建终端</span><kbd aria-hidden="true"><Plus size={13} /></kbd></button></div></>}</div></div>
      {!connected && <div className="connection-banner"><LoaderCircle className="spin" size={14} />连接已断开，正在重连。终端与对话仍在本机运行。</div>}
      {config.codexStatus === 'offline' && <div className="connection-banner">Codex 进程已断开，请在本机重启服务。</div>}
      <div className={`chat-panel ${activeTab === 'chat' ? 'visible' : ''} ${!hasMessages ? 'empty-chat' : ''}`}>
        {conversation?.archivedAt && <div className="archived-banner"><Archive size={16} /><span>此对话已归档，恢复后可以继续。</span><button disabled={!connected} onClick={() => { patchConversation(chatId, { archived: false }).catch(() => {}); }}><ArchiveRestore size={15} />恢复对话</button></div>}
        <div className="message-scroller" ref={messageList}><ChatContent ref={messageContent} key={chatId}>
          {chatOpened && (!hasMessages ? <div className="welcome"><div className="welcome-symbol"><Mark large /></div><h1>从一个想法开始</h1><p className="welcome-description">探索项目、编写代码，或一起解决一个问题。</p><div className="welcome-workspace" title={workspace?.path}><FolderOpen size={14} /><span>{workspace?.name || '正在连接工作区'}</span><span className="welcome-workspace-label">当前工作区</span></div></div> : <div className="messages">{conversation.turns.map(turn => <React.Fragment key={turn.id}><TurnItems turn={turn} conversation={conversation} />{turn.status === 'interrupted' && <div className="context-notice">已停止生成</div>}{turn.status === 'failed' && <div className="turn-error">{turn.error?.message || '本次回复失败，请重试。'}</div>}</React.Fragment>)}{requests.map(request => <Approval key={request.id} request={request} onError={setError} />)}{conversation.error && <div className="turn-error" role="alert">{conversation.error}</div>}</div>)}
        </ChatContent></div>
        {!nearBottom && <button className="jump-bottom" aria-label="回到最新消息" onClick={scrollToLatest}><ArrowUp size={16} /></button>}
        <div className="composer-section">{working && !requests.length && <WorkStatus conversation={conversation} submitting={submitting} />}<form className={`composer ${dragging ? 'drag-active' : ''}`} onSubmit={sendMessage}>{draft.files.length > 0 && <div className="upload-list">{draft.files.map(file => <UploadCard key={file.id} file={file} onRemove={() => removeFile(file)} onRetry={() => uploadFile(chatId, file)} />)}</div>}<SlashMenu ref={slashRef} value={draft.text} inputRef={textInput} disabled={!chatId || !!conversation?.archivedAt || !connected || commandBusy} working={working} onCommand={executeSlash} onComplete={text => updateDraft(chatId, value => ({ ...value, text }))} /><textarea aria-autocomplete="list" aria-controls="slash-command-menu" aria-haspopup="listbox" ref={textInput} aria-label="发送给 Codex" placeholder={conversation?.archivedAt ? '恢复对话后继续…' : working ? '补充要求或提问，继续当前任务…' : '描述任务，输入 / 查看命令…'} value={draft.text} disabled={!chatId || !!conversation?.archivedAt} rows={1} onChange={e => updateDraft(chatId, d => ({ ...d, text: e.target.value }))} onKeyDown={e => { if (slashRef.current?.handleKey(e)) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); sendMessage(); } }} onPaste={e => { const files = e.clipboardData.files; if (files.length) { e.preventDefault(); addFiles(files); } }} /><div className="composer-toolbar"><div className="composer-tools"><button type="button" className="icon-button attach-button" aria-label="添加附件" title="添加文件或文件夹" onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); setAttachmentMenu(attachmentMenu ? false : { left: bounds.left, bottom: window.innerHeight - bounds.top + 8 }); }} aria-expanded={!!attachmentMenu} disabled={!chatId || !!conversation?.archivedAt}><Plus size={20} /></button>{attachmentMenu && <><div className="menu-dismiss" onClick={() => setAttachmentMenu(false)} /><div className="add-menu attachment-menu" style={attachmentMenu}><button type="button" onClick={() => { setAttachmentMenu(false); fileInput.current?.click(); }}><Paperclip size={16} />添加文件</button><button type="button" onClick={() => { setAttachmentMenu(false); folderInput.current?.click(); }}><Folder size={16} />添加文件夹</button></div></>}<SessionControls conversation={conversation} models={config.models} modelsError={config.modelsError} disabled={working || !!conversation?.archivedAt || !connected || !chatId || config.codexStatus !== 'ready'} busy={settingsBusy || commandBusy} onChange={changeSettings} onRetry={refreshModels} menuRequest={selectorRequest} /></div><div className="composer-right"><span className="enter-hint">Enter 发送</span>{working && <button type="button" className="send-button stop-button" aria-label="停止生成" title="停止生成" disabled={submitting && !conversation?.activeTurnId} onClick={stop}><Square size={13} fill="currentColor" /></button>}<button className="send-button" type="submit" disabled={!canSend} aria-label="发送消息" title={working ? '发送补充消息' : '发送消息'}><ArrowUp size={20} strokeWidth={2.5} /></button></div></div></form><div className="composer-caption"><span>{conversation?.isDraft && (draft.text || draft.files.length) ? '草稿已保留在此浏览器' : '在当前工作区中执行任务'}</span><span>Enter 发送 · Shift + Enter 换行</span></div>
          {!hasMessages && <div className="suggestions" aria-label="开始一个任务">
            <button type="button" aria-label="探索项目" disabled={!chatId || !!conversation?.archivedAt} onClick={() => suggestTask('查看当前工作目录，介绍项目结构和可以从哪里开始。')}><Folder size={16} /><span className="suggestion-copy"><strong>探索项目</strong></span></button>
            <button type="button" aria-label="编写代码" disabled={!chatId || !!conversation?.archivedAt} onClick={() => suggestTask('帮我实现一个功能：')}><Code2 size={16} /><span className="suggestion-copy"><strong>编写代码</strong></span></button>
            <button type="button" aria-label="添加文件" disabled={!chatId || !!conversation?.archivedAt} onClick={() => fileInput.current?.click()}><Paperclip size={16} /><span className="suggestion-copy"><strong>添加文件</strong></span></button>
          </div>}
        </div>
        <TokenBar usage={conversation?.usage} outputSpeed={conversation?.outputSpeed ?? outputSpeedTracker.current.records.get(chatId)?.result} sessionStats={conversation?.sessionStats ?? (conversation ? sessionStatsTracker.current.summary(conversation) : null)} />
      </div>
      {terminals.map(t => <TerminalView key={t.id} terminal={t} active={activeTab === t.id} connected={connected} socketRef={socketRef} files={drafts[terminalDraftKey(t)]?.files || []} onUpload={incoming => addFiles(incoming, terminalDraftKey(t))} onRemove={file => removeFile(file, terminalDraftKey(t))} onRetry={file => uploadFile(terminalDraftKey(t), file)} onInserted={inserted => { const ids = new Set(inserted.map(file => file.id)); updateDraft(terminalDraftKey(t), draft => ({ ...draft, files: draft.files.filter(file => !ids.has(file.id)) })); }} onRestart={async () => { try { const terminal = await api('/api/terminals/default', { workspaceId: t.workspaceId }); setTerminals(previous => upsert(previous, terminal)); } catch (error) { setError(error.message); } }} />)}
      <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple className="visually-hidden" aria-label="选择上传文件夹" onChange={e => { addFiles(folderFromFiles(e.target.files)); e.target.value = ''; }} />
      <input ref={fileInput} type="file" multiple className="visually-hidden" aria-label="选择上传文件" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
      {readingDrop && <div className="reading-folder" role="status"><LoaderCircle size={16} className="spin" />正在读取文件夹…</div>}
      {dragging && <div className="drop-overlay"><div className="drop-box"><div className="drop-icon"><Upload size={32} strokeWidth={1.4} /></div><h2>把文件放到这里</h2><p>{activeTab === 'chat' ? '先上传到这台电脑，再添加到对话' : '上传完成后，可插入终端路径'}</p><small>支持文件与文件夹，保留目录结构</small></div></div>}
      {(error || notice) && <div className="toast" role="alert"><span>{error || notice}</span><button onClick={() => { setError(''); setNotice(''); }} aria-label="关闭提示"><X size={15} /></button></div>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
