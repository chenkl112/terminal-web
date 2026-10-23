import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function migrateWorkspaces(state, defaultPath) {
  state.workspaces ||= [];
  const canonical = fs.realpathSync(defaultPath);
  let initial = state.workspaces.find(workspace => workspace.path === canonical);
  if (!initial) {
    initial = { id: randomUUID(), name: path.basename(canonical) || canonical, path: canonical, createdAt: Date.now() };
    state.workspaces.unshift(initial);
  }
  for (const conversation of state.conversations) {
    const workspace = state.workspaces.find(w => w.id === conversation.workspaceId) || initial;
    conversation.workspaceId = workspace.id;
    conversation.cwd = workspace.path;
    conversation.updatedAt ||= conversation.createdAt;
    conversation.pinnedAt ||= null;
    conversation.archivedAt ||= null;
    delete conversation.archiving;
  }
  return initial.id;
}

export function getWorkspace(state, id, defaultId) {
  const workspace = state.workspaces.find(w => w.id === (id || defaultId));
  if (!workspace) throw Object.assign(new Error('工作区不存在，请重新选择'), { status: 404 });
  return workspace;
}

export function workspaceRouter({ state, defaultId, save, broadcast }) {
  const router = express.Router();
  router.get('/directories', async (req, res) => {
    try {
      const current = await fs.promises.realpath(typeof req.query.path === 'string' && req.query.path.trim() ? req.query.path.trim() : getWorkspace(state, defaultId).path);
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      const folders = (await Promise.all(entries.filter(entry => req.query.hidden === '1' || !entry.name.startsWith('.')).map(async entry => {
        if (entry.isDirectory()) return { name: entry.name, path: path.join(current, entry.name) };
        if (entry.isSymbolicLink()) {
          try { if ((await fs.promises.stat(path.join(current, entry.name))).isDirectory()) return { name: entry.name, path: path.join(current, entry.name) }; }
          catch { /* Skip unavailable links. */ }
        }
        return null;
      }))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      res.json({ path: current, parent: path.dirname(current) === current ? null : path.dirname(current), folders });
    } catch (error) {
      res.status(error.code === 'EACCES' ? 403 : 400).json({ error: error.code === 'EACCES' ? '没有权限读取这个文件夹' : '找不到这个文件夹，请检查路径' });
    }
  });
  router.post('/workspaces', async (req, res) => {
    if (typeof req.body.path !== 'string' || !path.isAbsolute(req.body.path.trim())) return res.status(400).json({ error: '请选择文件夹或输入完整路径' });
    let canonical;
    try {
      canonical = await fs.promises.realpath(req.body.path.trim());
      if (!(await fs.promises.stat(canonical)).isDirectory()) throw new Error('not a directory');
      await fs.promises.access(canonical, fs.constants.R_OK | fs.constants.X_OK);
    } catch { return res.status(400).json({ error: '工作区文件夹不存在或无法访问' }); }
    const existing = state.workspaces.find(w => w.path === canonical);
    if (existing) return res.json(existing);
    const workspace = { id: randomUUID(), name: path.basename(canonical) || canonical, path: canonical, createdAt: Date.now() };
    state.workspaces.push(workspace);
    save(true);
    broadcast({ type: 'workspaces', workspaces: state.workspaces });
    res.status(201).json(workspace);
  });
  return router;
}
