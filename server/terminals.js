import express from 'express';
import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { localEnv } from './codex.js';
import { getWorkspace } from './workspaces.js';

export const terminalInfo = t => ({ id: t.id, title: t.title, exited: t.exited, exitCode: t.exitCode, workspaceId: t.workspaceId, cwd: t.cwd, cols: t.cols, rows: t.rows, isDefault: !!t.isDefault });

export function terminalManager({ state, defaultWorkspaceId, terminals, broadcast, spawn = pty.spawn }) {
  let sequence = 0;
  function start(workspaceId, isDefault = false, previous = null) {
    const workspace = getWorkspace(state, workspaceId, defaultWorkspaceId);
    if (!previous && terminals.size >= 12) throw Object.assign(new Error('最多同时打开 12 个终端'), { status: 400 });
    const child = spawn(isDefault ? process.env.CODEX_BIN || 'codex' : process.env.SHELL || '/bin/bash', isDefault ? [] : ['-l'], {
      name: 'xterm-256color', cols: previous?.cols || 100, rows: previous?.rows || 30, cwd: workspace.path,
      env: { ...localEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const terminal = previous || { id: randomUUID(), workspaceId: workspace.id, cwd: workspace.path, title: isDefault ? '终端' : `终端 ${++sequence}`, cols: 100, rows: 30, isDefault };
    Object.assign(terminal, { pty: child, exited: false, replay: '' }); delete terminal.exitCode;
    terminals.set(terminal.id, terminal);
    child.onData(data => {
      if (terminal.pty !== child || !terminals.has(terminal.id)) return;
      terminal.replay = (terminal.replay + data).slice(-2 * 1024 * 1024);
      broadcast({ type: 'terminal/data', id: terminal.id, data });
    });
    child.onExit(({ exitCode }) => {
      if (terminal.pty !== child || !terminals.has(terminal.id)) return;
      terminal.exited = true; terminal.exitCode = exitCode;
      broadcast({ type: 'terminal/update', terminal: terminalInfo(terminal) });
    });
    if (previous) broadcast({ type: 'terminal/reset', id: terminal.id });
    broadcast({ type: previous ? 'terminal/update' : 'terminal/created', terminal: terminalInfo(terminal) });
    return terminal;
  }
  function ensureDefault(workspaceId) {
    const workspace = getWorkspace(state, workspaceId, defaultWorkspaceId);
    const terminal = [...terminals.values()].find(t => t.isDefault && t.workspaceId === workspace.id);
    return terminal && !terminal.exited ? terminal : start(workspace.id, true, terminal);
  }
  const router = express.Router();
  router.post('/default', (req, res) => res.json(terminalInfo(ensureDefault(req.body?.workspaceId))));
  router.post('/', (req, res) => res.status(201).json(terminalInfo(start(req.body?.workspaceId))));
  router.delete('/:id', (req, res) => {
    const terminal = terminals.get(req.params.id);
    if (terminal) { terminals.delete(terminal.id); terminal.pty.kill(); broadcast({ type: 'terminal/deleted', id: terminal.id }); }
    res.json({ ok: true });
  });
  return { router, ensureDefault };
}
