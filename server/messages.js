import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { turnSettings } from '../shared/settings.js';

export function createMessageSender({ codex, state, ensureLoaded, publish, uploadCleanup }) {
  return async function sendMessage(c, body) {
    if (codex.status !== 'ready') throw Object.assign(new Error('Codex 尚未就绪，请稍后重试'), { status: 503 });
    if (c.archivedAt || c.archiving) throw Object.assign(new Error('请先恢复归档的对话'), { status: 409 });
    if (c.starting || c.actionBusy || c.goalBusy) throw Object.assign(new Error('正在提交消息或执行会话操作，请稍后重试'), { status: 409 });
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const ids = body.attachments || [];
    if (!Array.isArray(ids) || ids.length > 20) throw Object.assign(new Error('最多附加 20 个文件'), { status: 400 });
    const attachments = ids.map(id => typeof id === 'string' && Object.hasOwn(state.uploads, id) && state.uploads[id]);
    if (attachments.some(file => !file || !fs.existsSync(file.path))) throw Object.assign(new Error('附件未上传完成或文件已被移除'), { status: 400 });
    if (!text && !attachments.length) throw Object.assign(new Error('请输入消息或添加附件'), { status: 400 });
    const skills = body.skills || [];
    if (!Array.isArray(skills) || skills.length > 10 || skills.some(skill => typeof skill?.name !== 'string' || typeof skill?.path !== 'string')) throw Object.assign(new Error('技能信息无效'), { status: 400 });
    uploadCleanup.touch(ids);
    c.starting = true;
    try {
      if (skills.length) {
        const available = (await codex.call('skills/list', { cwds: [c.cwd] })).data.flatMap(entry => entry.skills);
        if (skills.some(skill => !available.some(item => item.path === skill.path && item.name === skill.name && item.enabled !== false))) throw Object.assign(new Error('选择的技能不可用，请重新选择'), { status: 400 });
      }
      const active = !!c.activeTurnId || c.status === 'active' || c.turns.some(turn => turn.status === 'inProgress');
      // Resuming a running thread can disturb its current task; it is already loaded.
      if (!active) await ensureLoaded(c);
      c.error = null;
      const clientId = randomUUID();
      c.attachments[clientId] = { text, files: attachments };
      uploadCleanup.markUsed(ids);
      const fileContext = attachments.length ? '\n\n用户已将以下附件上传至本机，可通过绝对路径读取：\n' + attachments.map(file => JSON.stringify({ name: file.name, path: file.path, size: file.size, ...(file.kind === 'folder' ? { kind: 'folder', fileCount: file.fileCount } : {}) })).join('\n') : '';
      const input = [{ type: 'text', text: (text || '请查看我上传的文件。') + fileContext, text_elements: [] }];
      for (const skill of skills) input.push({ type: 'skill', name: skill.name, path: skill.path });
      for (const file of attachments) if (file.image) input.push({ type: 'localImage', path: file.path });
      // Native turn/start adds input to an active turn, or starts a turn if it has
      // just finished. Let Codex make that decision atomically instead of stopping
      // the turn or racing a turn/steer precondition with completion notifications.
      const result = await codex.call('turn/start', { threadId: c.threadId, clientUserMessageId: clientId, input, cwd: c.cwd, ...turnSettings(c) });
      const known = c.turns.find(turn => turn.id === result.turn.id);
      if (!known || known.status === 'inProgress') {
        c.activeTurnId = result.turn.id;
        c.status = 'active';
      }
      c.updatedAt = Date.now();
      if (c.title === '新建任务' || c.title === '新对话') c.title = (text || attachments[0]?.name || '新建任务').slice(0, 30);
      publish(c);
      return { turnId: result.turn.id };
    } finally { c.starting = false; }
  };
}
