import { randomUUID } from 'node:crypto';
import { getWorkspace } from './workspaces.js';
import { validateSettings } from '../shared/settings.js';

export async function startTask({ options, codex, state, models, defaultWorkspaceId, loaded, save, broadcast, startTurn }) {
  if (codex.status !== 'ready') throw Object.assign(new Error('Codex 尚未就绪，请稍后重试'), { status: 503 });
  const settings = options.model ? validateSettings({}, options, models) : { permissionMode: 'workspace-write', fast: false, mode: 'default' };
  const workspace = getWorkspace(state, options.workspaceId, defaultWorkspaceId);
  const started = await codex.call('thread/start', {
    cwd: workspace.path,
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { config: { model_reasoning_effort: settings.effort } } : {}),
    sandbox: settings.permissionMode === 'full-access' ? 'danger-full-access' : settings.permissionMode === 'read-only' ? 'read-only' : 'workspace-write',
    approvalPolicy: settings.permissionMode === 'full-access' ? 'never' : 'on-request',
    serviceTier: settings.fast ? 'priority' : 'default',
  });
  const conversation = { id: randomUUID(), threadId: started.thread.id, title: '新建任务', model: started.model || settings.model,
    effort: started.reasoningEffort || settings.effort, permissionMode: settings.permissionMode, fast: settings.fast, mode: settings.mode,
    workspaceId: workspace.id, cwd: workspace.path, createdAt: Date.now(), updatedAt: Date.now(), pinnedAt: null, archivedAt: null,
    turns: [], usage: null, status: 'idle', activeTurnId: null, attachments: {}, provisional: true };
  state.conversations.unshift(conversation); loaded.add(conversation.threadId);
  try {
    const turn = await startTurn(conversation, options);
    delete conversation.provisional;
    save(true); broadcast({ type: 'conversation', conversation });
    return { conversation, ...turn };
  } catch (error) {
    state.conversations = state.conversations.filter(item => item.id !== conversation.id);
    loaded.delete(conversation.threadId);
    throw error;
  }
}
