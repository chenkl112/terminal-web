export const permissionModes = [
  { id: 'read-only', label: '只读', description: '读取文件；修改和额外操作需要确认。', sandbox: 'read-only', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  { id: 'workspace-write', label: '默认权限', description: '可修改工作区文件，额外权限需要确认。', sandbox: 'workspace-write', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } },
  { id: 'full-access', label: '完全访问', description: '可读写本机文件、执行命令并联网，无需逐次确认。', sandbox: 'danger-full-access', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
];

export const effortLabels = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高', ultra: 'Ultra' };
export const effortDescriptions = { minimal: '尽快响应', low: '更快完成简单任务', medium: '兼顾速度与推理深度', high: '深入处理复杂问题', xhigh: '投入更多推理', max: '适合最复杂的任务', ultra: '最大推理投入，支持自动任务委派' };

export const supportsFast = model => !!(model?.serviceTiers?.some(tier => tier.id === 'priority') || model?.additionalSpeedTiers?.includes('fast'));

export function permissionFor(mode = 'workspace-write') {
  const permission = permissionModes.find(p => p.id === mode);
  if (!permission) throw Object.assign(new Error('无效的权限模式'), { status: 400 });
  return permission;
}

export function validateSettings(current, patch, models) {
  const model = patch.model ?? current.model;
  const selected = models.find(m => m.model === model);
  if (!selected) throw Object.assign(new Error('该模型不在本机 Codex 的可用列表中'), { status: 400 });
  const supported = selected.supportedReasoningEfforts.map(e => e.reasoningEffort);
  let effort = patch.effort ?? current.effort ?? selected.defaultReasoningEffort;
  if (!supported.includes(effort)) {
    if (patch.effort !== undefined) throw Object.assign(new Error('该模型不支持此思考深度'), { status: 400 });
    effort = selected.defaultReasoningEffort;
  }
  const permissionMode = patch.permissionMode ?? current.permissionMode ?? 'workspace-write';
  permissionFor(permissionMode);
  if (patch.fast !== undefined && typeof patch.fast !== 'boolean') throw Object.assign(new Error('Fast 配置无效'), { status: 400 });
  if (patch.fast === true && !supportsFast(selected)) throw Object.assign(new Error('该模型暂不支持 Fast'), { status: 400 });
  const fast = supportsFast(selected) && (patch.fast ?? current.fast ?? false);
  const mode = patch.mode ?? current.mode ?? 'default';
  if (!['default', 'plan'].includes(mode)) throw Object.assign(new Error('对话模式无效'), { status: 400 });
  return { model, effort, permissionMode, fast, mode };
}

export function turnSettings(conversation) {
  const permission = permissionFor(conversation.permissionMode);
  return { model: conversation.model, effort: conversation.effort,
    serviceTier: conversation.fast ? 'priority' : 'default',
    collaborationMode: { mode: conversation.mode || 'default', settings: { model: conversation.model, reasoning_effort: conversation.effort, developer_instructions: null } },
    approvalPolicy: permission.approvalPolicy, sandboxPolicy: permission.sandboxPolicy };
}
