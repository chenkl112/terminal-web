import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CornerDownLeft, Search, Slash } from 'lucide-react';

export const slashCommands = [
  { id: 'new', title: '新建对话', description: '在当前工作区开始新对话', aliases: ['clear'] },
  { id: 'resume', title: '历史会话', description: '搜索并打开全部历史', aliases: ['history'] },
  { id: 'model', title: '切换模型', description: '选择当前对话使用的模型', args: '模型名称', idle: true },
  { id: 'effort', title: '思考深度', description: '调整推理投入', args: 'low / medium / high…', idle: true },
  { id: 'fast', title: 'Fast 模式', description: '切换优先处理，可能增加用量', args: 'on / off', idle: true },
  { id: 'permissions', title: '权限模式', description: '设置只读、默认权限或完全访问', aliases: ['approvals'], args: '权限', idle: true },
  { id: 'plan', title: '规划模式', description: '先分析和制定计划', args: 'on / off', idle: true },
  { id: 'goal', title: '目标任务', description: '创建、查看、暂停或继续目标', args: '目标描述 / pause / resume / clear' },
  { id: 'compact', title: '压缩上下文', description: '让 Codex 压缩当前会话上下文', idle: true },
  { id: 'fork', title: '分支对话', description: '保留历史，在新分支中继续', idle: true },
  { id: 'review', title: '代码审查', description: '审查当前工作区未提交的修改', args: '审查要求', idle: true },
  { id: 'diff', title: '查看差异', description: '查看已跟踪文件相对 HEAD 的改动' },
  { id: 'skills', title: '技能', description: '选择本机可用的技能' },
  { id: 'init', title: '初始化项目说明', description: '让 Codex 创建或更新 AGENTS.md', idle: true },
  { id: 'status', title: '会话状态', description: '查看模型、模式、权限与用量' },
  { id: 'rename', title: '重命名对话', description: '修改当前对话名称', args: '对话名称' },
  { id: 'archive', title: '归档对话', description: '将当前对话移到归档', idle: true },
  { id: 'stop', title: '停止生成', description: '停止当前回复', aliases: ['interrupt'] },
  { id: 'help', title: '命令帮助', description: '查看全部可用的斜杠命令' },
];
export function parseSlash(text) {
  const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { command: slashCommands.find(command => command.id === name || command.aliases?.includes(name)), name, argument: match[2]?.trim() || '' };
}

export default forwardRef(function SlashMenu({ value, inputRef, disabled, working, onCommand, onComplete }, ref) {
  const [selected, setSelected] = useState(0), [dismissed, setDismissed] = useState(false);
  const list = useRef(null);
  const match = /^\/([^/\s]*)$/.exec(value.trimStart());
  const query = match?.[1].toLowerCase() || '';
  const items = slashCommands.filter(command => `${command.id} ${command.title} ${command.description} ${command.aliases?.join(' ') || ''}`.toLowerCase().includes(query));
  const visible = !!match && !disabled && !dismissed;
  const index = Math.min(selected, Math.max(0, items.length - 1));
  useEffect(() => { setSelected(0); setDismissed(false); }, [value]);
  useEffect(() => {
    const input = inputRef.current;
    input?.setAttribute('aria-expanded', String(visible));
    if (visible && items[index]) input?.setAttribute('aria-activedescendant', `slash-option-${items[index].id}`);
    else input?.removeAttribute('aria-activedescendant');
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    return () => input?.removeAttribute('aria-activedescendant');
  }, [visible, index, query]);
  const unavailable = command => working && command.idle;
  useImperativeHandle(ref, () => ({ handleKey(event) {
    if (!visible || event.nativeEvent.isComposing || event.keyCode === 229) return false;
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return true; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setSelected((index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % (items.length || 1)); return true; }
    if ((event.key === 'Enter' || event.key === 'Tab') && items[index] && !event.shiftKey) {
      event.preventDefault();
      if (unavailable(items[index])) return true;
      if (event.key === 'Tab') onComplete(`/${items[index].id} `); else onCommand(items[index].id, '');
      setDismissed(true); return true;
    }
    return false;
  } }));
  if (!visible) return null;
  return <div className="slash-menu" ref={list}>
    <div className="slash-heading"><Slash size={14} /><span>命令</span><small>↑ ↓ 选择 · Tab 补全 · Enter 执行</small></div>
    <div id="slash-command-menu" role="listbox" aria-label="斜杠命令">{items.map((command, itemIndex) => <button key={command.id} id={`slash-option-${command.id}`} type="button" role="option" aria-selected={index === itemIndex} disabled={unavailable(command)} className="slash-option" onPointerMove={() => setSelected(itemIndex)} onMouseDown={event => event.preventDefault()} onClick={() => { setDismissed(true); onCommand(command.id, ''); }}>
      <span className="slash-name">/{command.id}</span><span className="slash-description"><strong>{command.title}</strong><small>{unavailable(command) ? '等待当前回复结束' : command.description}</small></span>{index === itemIndex && <CornerDownLeft size={13} />}
    </button>)}</div>
    {!items.length && <div className="slash-empty"><Search size={16} />没有匹配的命令，输入 /help 查看帮助</div>}
  </div>;
});
