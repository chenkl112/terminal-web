import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { decodeFileReference, isLocalFileReference } from '../shared/media.js';

const referenceCache = new Map();
function markdownReferences(text) {
  if (referenceCache.has(text)) return referenceCache.get(text);
  const refs = [];
  marked.walkTokens(marked.lexer(text), token => {
    if ((token.type === 'image' || token.type === 'link') && isLocalFileReference(token.href)) refs.push(token.href);
    if (token.type === 'html') for (const match of token.text.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const value = match[1] ?? match[2] ?? match[3]; if (isLocalFileReference(value)) refs.push(value);
    }
  });
  if (referenceCache.size >= 500) referenceCache.delete(referenceCache.keys().next().value);
  referenceCache.set(text, refs); return refs;
}
function resolveReference(reference, cwd) {
  try {
    if (!isLocalFileReference(reference)) return null;
    if (/^file:/i.test(reference)) { const value = fileURLToPath(reference); return value.includes('\0') ? null : value; }
    const raw = reference.replace(/^sandbox:/i, '').split(/[?#]/)[0];
    // Markdown often contains literal filesystem names such as “含100%标准线.zip”.
    // A standalone % is valid in a filename and is not necessarily URL encoding.
    let value = decodeFileReference(raw);
    value = value.replace(/:\d+(?::\d+)?$/, '');
    if (!value || value.includes('\0')) return null;
    return path.resolve(cwd, value);
  } catch { return null; }
}
function referencedFiles(conversation) {
  const files = new Map();
  const add = (reference, nativeImage = false) => {
    const filename = resolveReference(reference, conversation.cwd);
    if (filename) files.set(filename, { nativeImage: nativeImage || files.get(filename)?.nativeImage });
  };
  for (const turn of conversation.turns) for (const item of turn.items) {
    if (item.type === 'agentMessage' && item.text) markdownReferences(item.text).forEach(reference => add(reference));
    if (item.type === 'imageView') add(item.path, true);
    if (item.type === 'imageGeneration') add(item.savedPath || item.result, true);
  }
  return files;
}
function imageMime(header) {
  if (header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(header.toString('ascii', 0, 6))) return 'image/gif';
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (header.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (header.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(header.toString('ascii', 8, 32))) return 'image/avif';
  return null;
}
export function mediaRouter({ state }) {
  const router = express.Router();
  router.get('/:id/files', async (req, res, next) => {
    const conversation = state.conversations.find(c => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: '对话不存在' });
    if (typeof req.query.path !== 'string') return res.status(400).json({ error: '文件路径无效' });
    const filename = resolveReference(req.query.path, conversation.cwd);
    const reference = filename && referencedFiles(conversation).get(filename);
    if (!reference) return res.status(403).json({ error: '此文件未在当前对话中提供' });
    let file, stat, mime;
    try {
      file = await fs.realpath(filename); stat = await fs.stat(file);
      if (!stat.isFile()) return res.status(404).json({ error: '文件不存在或已被移动' });
      const handle = await fs.open(file, 'r');
      try { const header = Buffer.alloc(64); const { bytesRead } = await handle.read(header, 0, 64, 0); mime = imageMime(header.subarray(0, bytesRead)); }
      finally { await handle.close(); }
      if (req.query.image === '1' && !mime) return res.status(415).json({ error: '此文件无法作为图片预览，请下载查看' });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return res.status(404).json({ error: '文件不存在或已被移动' });
      if (error.code === 'EACCES') return res.status(403).json({ error: '无法读取此文件' });
      throw error;
    }
    const name = path.basename(filename);
    if (req.query.download === '1' || !mime) res.attachment(name);
    else res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase())}`);
    res.type(mime || 'application/octet-stream');
    res.set({ 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=0, must-revalidate' });
    res.sendFile(file, { dotfiles: 'allow' }, error => { if (error) next(error); });
  });
  return router;
}
