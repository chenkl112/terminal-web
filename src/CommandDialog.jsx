import React, { useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { Modal } from './Sidebar.jsx';
import { slashCommands } from './SlashMenu.jsx';
import { effortLabels, permissionModes } from '../shared/settings.js';
import { usageMetrics } from '../shared/conversation.js';

export default function CommandDialog({ dialog, conversation, workspace, onClose, onRename, onSkill, onCommand }) {
  const [name, setName] = useState(conversation?.title || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const metrics = usageMetrics(conversation?.usage);
  const titles = { help: '斜杠命令', status: '当前会话', rename: '重命名对话', skills: '选择技能', diff: '工作区差异', loading: dialog.title };
  const fields = [['工作区', workspace?.path], ['模型', conversation?.model], ['思考深度', effortLabels[conversation?.effort] || conversation?.effort],
    ['Fast', conversation?.fast ? '已开启 · 优先处理' : '已关闭'], ['对话模式', conversation?.mode === 'plan' ? '规划模式' : '普通对话'],
    ['权限', permissionModes.find(item => item.id === conversation?.permissionMode)?.label], ['累计 token', metrics.total?.toLocaleString('en-US')],
    ['当前上下文', metrics.used == null ? '等待数据' : `${metrics.used.toLocaleString('en-US')} / ${metrics.capacity?.toLocaleString('en-US') || '—'}`]];
  return <Modal title={titles[dialog.kind]} onClose={() => { if (!busy) onClose(); }} className="command-modal">
    {dialog.kind === 'loading' && <div className="directory-empty"><LoaderCircle className="spin" size={22} />正在读取…</div>}
    {dialog.kind === 'help' && <div className="command-help">{slashCommands.map(command => <button key={command.id} onClick={() => { onClose(); onCommand(command.id, ''); }}><code>/{command.id}{command.args && <small> {command.args}</small>}</code><span>{command.description}</span></button>)}</div>}
    {dialog.kind === 'status' && <dl className="command-status">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl>}
    {dialog.kind === 'diff' && <pre className="command-diff">{dialog.text}</pre>}
    {dialog.kind === 'skills' && <div className="command-skills">{dialog.skills.map(skill => <button key={skill.path} disabled={skill.enabled === false} onClick={() => onSkill(skill)}><Sparkles size={16} /><span><strong>{skill.name}</strong><small>{skill.description || skill.shortDescription}</small></span></button>)}{!dialog.skills.length && <div className="directory-empty">当前工作区没有可用技能</div>}</div>}
    {dialog.kind === 'rename' && <form className="command-rename" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await onRename(name); onClose(); } catch (error) { setError(error.message); } finally { setBusy(false); } }}><label htmlFor="command-rename">对话名称</label><input id="command-rename" value={name} maxLength={100} onChange={event => setName(event.target.value)} />{error && <p role="alert">{error}</p>}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy || !name.trim()}>{busy ? '正在保存…' : '保存'}</button></footer></form>}
  </Modal>;
}
