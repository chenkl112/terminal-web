import React, { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import { Modal } from './Sidebar.jsx';
export const goalStatuses = { active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量受限', budgetLimited: '预算已用尽', complete: '已完成' };
const count = value => (value || 0).toLocaleString('en-US');
export default function GoalDialog({ goal, loading, working, onClose, onAction }) {
  const [objective, setObjective] = useState(''), [budget, setBudget] = useState(goal?.tokenBudget?.toString() || ''), [error, setError] = useState('');
  useEffect(() => setBudget(goal?.tokenBudget?.toString() || ''), [goal?.threadId, goal?.tokenBudget]);
  async function act(operation) {
    setError('');
    const tokenBudget = budget.trim() ? Number(budget) : null;
    if (['create', 'budget'].includes(operation) && tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) { setError('预算请填写正整数，留空表示不限'); return; }
    try { await onAction(operation, operation === 'create' ? { objective, tokenBudget } : operation === 'budget' ? { tokenBudget } : {}); if (operation === 'create') onClose(); }
    catch (error) { setError(error.message); }
  }
  return <Modal title="目标任务" onClose={() => { if (!loading) onClose(); }} className="goal-modal">
    <p className="workspace-picker-caption">设置目标后，Codex 会持续推进，直到完成、暂停或达到用量限制。</p>
    {goal && <div className="goal-details"><div className="goal-detail-heading"><Target size={17} /><strong>{goalStatuses[goal.status] || goal.status}</strong></div><p className="goal-detail-objective">{goal.objective}</p><dl><div><dt>已用 Token</dt><dd>{count(goal.tokensUsed)}</dd></div><div><dt>运行时间</dt><dd>{count(goal.timeUsedSeconds)} 秒</dd></div><div><dt>Token 预算</dt><dd>{goal.tokenBudget == null ? '不限' : count(goal.tokenBudget)}</dd></div></dl>{goal.tokenBudget > 0 && <div className="goal-budget-track" role="progressbar" aria-label="目标预算进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(goal.tokensUsed / goal.tokenBudget * 100))}><span style={{ width: `${Math.min(100, goal.tokensUsed / goal.tokenBudget * 100)}%` }} /></div>}</div>}
    {(!goal || goal.status === 'complete') && <form className="goal-form" onSubmit={event => { event.preventDefault(); act('create'); }}><label htmlFor="goal-objective">目标描述</label><textarea id="goal-objective" rows={4} maxLength={20000} value={objective} onChange={event => setObjective(event.target.value)} placeholder="例如：完成登录功能，并运行测试验证。" disabled={loading} /><label htmlFor="goal-budget">Token 预算（可选）</label><input id="goal-budget" type="number" min="1" step="1" value={budget} onChange={event => setBudget(event.target.value)} placeholder="留空表示不限" disabled={loading} />{working && <small>当前回复结束后可以启动目标。</small>}<footer><button type="button" disabled={loading} onClick={onClose}>取消</button><button className="primary" disabled={loading || working || !objective.trim()}>设置并开始</button></footer></form>}
    {goal && goal.status !== 'complete' && <div className="goal-form"><label htmlFor="goal-budget">Token 预算（可选）</label><div className="goal-budget-editor"><input id="goal-budget" type="number" min="1" step="1" value={budget} onChange={event => setBudget(event.target.value)} placeholder="留空表示不限" disabled={loading} /><button disabled={loading} onClick={() => act('budget')}>更新预算</button></div><footer><button disabled={loading} onClick={() => act('clear')}>清除目标</button>{goal.status === 'active' ? <button className="primary" disabled={loading} onClick={() => act('pause')}>暂停目标</button> : <button className="primary" disabled={loading || working} onClick={() => act('resume')}>继续目标</button>}</footer></div>}
    {error && <p className="goal-error" role="alert">{error}</p>}
  </Modal>;
}
