import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ListChecks, LoaderCircle, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import { effortLabels, effortDescriptions, permissionModes, supportsFast } from '../shared/settings.js';

export default function SessionControls({ conversation, models = [], modelsError, disabled, busy, onChange, onRetry, menuRequest }) {
  const [menu, setMenu] = useState(null);
  const root = useRef(null);
  const lastRequest = useRef(null);
  const model = models.find(m => m.model === conversation?.model);
  const permission = permissionModes.find(p => p.id === conversation?.permissionMode) || permissionModes[1];
  useEffect(() => {
    const pointer = event => { if (!root.current?.contains(event.target)) setMenu(null); };
    const key = event => { if (event.key === 'Escape') setMenu(null); };
    const close = () => setMenu(null);
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); window.removeEventListener('resize', close); };
  }, []);
  useEffect(() => { setMenu(null); }, [conversation?.id, disabled]);
  useEffect(() => {
    const element = root.current?.querySelector(`[data-control="${menuRequest?.kind}"]`);
    if (element && !element.disabled && lastRequest.current !== menuRequest) { lastRequest.current = menuRequest; toggle(menuRequest.kind, { currentTarget: element }, true); }
  }, [menuRequest, busy, disabled]);

  function toggle(kind, event, force = false) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = Math.min(kind === 'model' ? 310 : 285, window.innerWidth - 24);
    setMenu(current => !force && current?.kind === kind ? null : { kind, width,
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)),
      bottom: window.innerHeight - bounds.top + 9, maxHeight: Math.min(420, bounds.top - 20) });
  }
  function select(patch) { setMenu(null); onChange(patch); }
  const buttonProps = kind => ({ type: 'button', 'data-control': kind, className: `selector-trigger ${menu?.kind === kind ? 'is-open' : ''}`,
    disabled: disabled || busy, 'aria-haspopup': 'menu', 'aria-expanded': menu?.kind === kind,
    onClick: event => toggle(kind, event) });
  const heading = { model: '选择模型', effort: '思考深度', permission: '权限模式' };
  return <div className="session-controls" ref={root}>
    <button {...buttonProps('model')} aria-label="选择模型"><span className="model-name">{model?.displayName || conversation?.model || '选择模型'}</span><ChevronDown size={11} /></button>
    <button {...buttonProps('effort')} disabled={disabled || busy || !model?.supportedReasoningEfforts?.length} aria-label="选择思考深度"><span>{effortLabels[conversation?.effort] || conversation?.effort || '思考深度'}</span><ChevronDown size={11} /></button>
    <button type="button" className={`selector-trigger fast-toggle ${conversation?.fast ? 'is-active' : ''}`} aria-label="Fast 模式" aria-pressed={!!conversation?.fast} disabled={disabled || busy || !supportsFast(model)} title={supportsFast(model) ? 'Fast 优先处理，可能增加用量；应用于下一条消息' : '当前模型不支持 Fast'} onClick={() => onChange({ fast: !conversation?.fast })}><Zap size={13} fill={conversation?.fast ? 'currentColor' : 'none'} /><span>Fast</span></button>
    {conversation?.mode === 'plan' && <button type="button" className="selector-trigger mode-toggle" aria-label="退出规划模式" disabled={disabled || busy} title="当前为规划模式，点击恢复普通对话" onClick={() => onChange({ mode: 'default' })}><ListChecks size={13} />规划</button>}
    <span className="control-divider" />
    <button {...buttonProps('permission')} aria-label="选择权限"><ShieldCheck size={12} /><span>{permission.label}</span><ChevronDown size={11} /></button>
    {busy && <LoaderCircle className="spin settings-saving" size={12} />}
    {menu && <div className={`selector-menu ${menu.kind}-menu`} role="menu" aria-label={heading[menu.kind]} style={{ left: menu.left, bottom: menu.bottom, width: menu.width, maxHeight: menu.maxHeight }}>
      <div className="selector-heading">{heading[menu.kind]}</div>
      {menu.kind === 'model' && <>{models.map(m => <button type="button" role="menuitemradio" aria-checked={m.model === conversation?.model} className="selector-option" key={m.model} onClick={() => select({ model: m.model })}><span><strong>{m.displayName}</strong><small>{m.model}</small></span>{m.model === conversation?.model && <Check size={14} />}</button>)}{!models.length && <div className="models-empty">{modelsError || '正在读取模型列表…'}</div>}<button className="refresh-models" type="button" onClick={onRetry}><RefreshCw size={12} />重新获取模型</button></>}
      {menu.kind === 'effort' && model?.supportedReasoningEfforts.map(option => <button type="button" role="menuitemradio" aria-checked={option.reasoningEffort === conversation?.effort} className="selector-option" key={option.reasoningEffort} onClick={() => select({ effort: option.reasoningEffort })}><span><strong>{effortLabels[option.reasoningEffort] || option.reasoningEffort}<em>{option.reasoningEffort}</em></strong><small>{effortDescriptions[option.reasoningEffort] || option.description}</small></span>{option.reasoningEffort === conversation?.effort && <Check size={14} />}</button>)}
      {menu.kind === 'permission' && permissionModes.map(p => <button type="button" role="menuitemradio" aria-checked={p.id === permission.id} className="selector-option" key={p.id} onClick={() => select({ permissionMode: p.id })}><span><strong>{p.label}</strong><small>{p.description}</small></span>{p.id === permission.id && <Check size={14} />}</button>)}
      <div className="selector-footnote">应用于此对话的下一条消息</div>
    </div>}
  </div>;
}
