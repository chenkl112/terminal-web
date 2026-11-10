import express from 'express';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFileReference } from '../shared/media.js';

function resolveReference(reference, cwd) {
  if (typeof reference !== 'string' || reference.length > 8192 || /[\0\r\n]/.test(reference)) return null;
  let value = reference.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!value || !cwd || !path.isAbsolute(cwd)) return null;
  try {
    if (/^file:/i.test(value)) value = fileURLToPath(value);
    else {
      value = value.replace(/^sandbox:/i, '');
      value = decodeFileReference(value);
    }
    value = value.replace(/:\d+(?::\d+)?$/, '');
    if (!value || /[\0\r\n]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
    if (value === '~' || value.startsWith('~/')) value = path.join(os.homedir(), value.slice(1));
    return path.resolve(cwd, value);
  } catch { return null; }
}

function fileError(error) {
  if (['ENOENT', 'ENOTDIR'].includes(error.code) || error.status === 404) return [404, '文件不存在或已被移动'];
  if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code) || error.status === 403) return [403, '无法读取此文件'];
  if (error.status === 416) return [416, '下载范围无效，请重新下载'];
  return null;
}

const problem = (status, message) => Object.assign(new Error(message), { status });
async function inspectFile(reference, terminal) {
  const filename = resolveReference(reference, terminal.cwd);
  if (!filename) throw problem(400, '文件路径无效，请填写文件的本机路径');
  const file = await fs.realpath(filename);
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw problem(400, '这是一个文件夹，请先在终端中打包为 ZIP 再下载');
  if (!stat.isFile()) throw problem(400, '只能下载普通文件');
  await fs.access(file, constants.R_OK);
  return { file, name: path.basename(filename), path: filename, size: stat.size };
}
function sendProblem(error, res, next) {
  if (error.status && !error.code) return res.status(error.status).json({ error: error.message });
  const failure = fileError(error);
  if (failure) return res.status(failure[0]).json({ error: failure[1] });
  next(error);
}

export function terminalDownloadsRouter({ terminals }) {
  const router = express.Router();
  router.post('/:id/files/check', async (req, res, next) => {
    const terminal = terminals.get(req.params.id);
    if (!terminal) return res.status(404).json({ error: '终端不存在，请重新打开终端' });
    const references = req.body?.paths;
    if (!Array.isArray(references) || references.length > 100 || references.some(value => typeof value !== 'string' || value.length > 8192)) return res.status(400).json({ error: '文件列表无效' });
    try {
      const files = [];
      // Validate suggestions, not directories or random text. Keep request and I/O bounded.
      const unique = [...new Set(references)];
      for (let index = 0; index < unique.length; index += 4) {
        const checked = await Promise.all(unique.slice(index, index + 4).map(async reference => {
          try { const { file, ...info } = await inspectFile(reference, terminal); return { ...info, reference }; }
          catch (error) { if (error.status && error.status < 500 || fileError(error)) return null; throw error; }
        }));
        files.push(...checked.filter(Boolean));
      }
      res.json({ files: files.filter((file, index) => files.findIndex(other => other.path === file.path) === index) });
    } catch (error) { sendProblem(error, res, next); }
  });
  // Express also routes HEAD here, so validation and download headers match GET.
  router.get('/:id/files', async (req, res, next) => {
    const terminal = terminals.get(req.params.id);
    if (!terminal) return res.status(404).json({ error: '终端不存在，请重新打开终端' });
    try {
      const { file, ...info } = await inspectFile(req.query.path, terminal);
      if (req.query.info === '1') return res.json(info);
      res.attachment(info.name);
      res.type('application/octet-stream');
      res.set({
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=0, must-revalidate',
      });
      res.sendFile(file, { dotfiles: 'allow' }, error => {
        if (!error || error.code === 'ECONNABORTED' || req.aborted || res.destroyed) return;
        const failure = fileError(error);
        if (!res.headersSent && failure) {
          res.removeHeader('Content-Disposition');
          res.status(failure[0]).json({ error: failure[1] });
        } else next(error);
      });
    } catch (error) {
      sendProblem(error, res, next);
    }
  });
  return router;
}
