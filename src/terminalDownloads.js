// Terminal output is text, so these are suggestions; the download endpoint checks
// that a selected path really is an accessible regular file before downloading.
import { decodeFileReference, imageFileName } from '../shared/media.js';

export function terminalAssetUrl(reference, origin) {
  if (typeof reference !== 'string' || reference.length > 8192 || /[\x00-\x1f\x7f\\]/.test(reference)) return '';
  let value = reference.trim();
  const markdown = value.match(/^\[[^\]]*\]\((.*)\)$/u);
  if (markdown) value = markdown[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('<') && value.endsWith('>')) || (value.startsWith('`') && value.endsWith('`'))) value = value.slice(1, -1);
  if (value.startsWith('assets/')) value = '/' + value;
  if (/^https?:\/\//i.test(value)) {
    try {
      if (!origin || new URL(value).origin !== new URL(origin).origin) return '';
      value = value.replace(/^https?:\/\/[^/?#]+/i, '');
    } catch { return ''; }
  }
  if (!value.startsWith('/assets/')) return '';
  const decoded = decodeFileReference(value.split(/[?#]/)[0]);
  if (/[\\\x00-\x1f\x7f]/.test(decoded) || /%(?:2e|2f|5c|00|0a|0d)/i.test(decoded)) return '';
  const segments = decoded.split('/');
  if (segments.some(segment => segment === '.' || segment === '..') || !segments.at(-1)) return '';
  const search = value.match(/\?[^#]*/)?.[0] || '';
  return segments.map(segment => encodeURIComponent(segment)).join('/') + search;
}

export async function inspectTerminalAsset(reference, { origin, signal, fetch: fetchFile = fetch } = {}) {
  const url = terminalAssetUrl(reference, origin);
  if (!url) throw new Error('网页资源链接无效');
  const response = await fetchFile(url, { method: 'HEAD', redirect: 'error', signal });
  if (!response.ok) throw new Error(response.status === 404 ? '文件不存在或已被移动' : `无法下载此文件（${response.status}）`);
  // The SPA fallback also returns 200. Never offer its index.html as a ZIP/file.
  if (/text\/html/i.test(response.headers.get('content-type') || '')) {
    if (!/\.html?$/i.test(imageFileName(url))) throw new Error('文件不存在或已被移动');
    const index = await fetchFile('/', { method: 'HEAD', redirect: 'error', signal });
    const tag = response.headers.get('etag');
    if (!tag || tag === index.headers.get('etag')) throw new Error('文件不存在或已被移动');
  }
  return { name: imageFileName(url), path: decodeFileReference(url.split('?')[0]),
    size: Number(response.headers.get('content-length')) || 0, reference: url, asset: true };
}

export function normalizeTerminalDownloadPath(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return '';
  let path = value.trim();
  const markdown = path.match(/^\[[^\]]*\]\((.*)\)$/u);
  if (markdown) path = markdown[1].trim();
  if (/^(["'`<]).*["'`>]$/u.test(path)) {
    const end = path[0] === '<' ? '>' : path[0];
    if (path.endsWith(end)) path = path.slice(1, -1);
  }
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/, '');
  const asset = terminalAssetUrl(path);
  if (asset) return asset;
  if (/^file:\/\/(?:localhost)?\//i.test(path)) {
    const filename = path.replace(/^file:\/\/(?:localhost)?/i, '');
    return normalizeTerminalDownloadPath(filename) ? path : '';
  }
  path = path.replace(/^sandbox:/i, '');
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.startsWith('-') || /[<>|*?]/.test(path)) return '';
  if (/(?:\/|\/\.{1,2})$/.test(path) || ['.', '..', '~'].includes(path)) return '';
  // A slash command such as /help is not a file suggestion. Explicit relative
  // paths and nested absolute paths may legitimately name extensionless files.
  if (path.startsWith('/')) return path.slice(1).includes('/') || /\.[\p{L}\p{N}]{1,16}$/u.test(path) ? path : '';
  if (/^(?:~\/|\.\.?\/)/.test(path)) return path;
  if (/[:#=]/.test(path)) return '';
  // Bare sizes, counters and CLI versions are not evidence of a file path.
  // Explicit paths such as ./2.33M can still refer to a real filename.
  if (/^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/i.test(path)
    || /^\d+(?:\.\d+)?\s*(?:[kmgtpe](?:i?b)?|bytes?|ms|s|tok(?:ens)?)(?:\/s)?$/i.test(path)) return '';
  return path.includes('/') || /^[^\s.][^/]*\.[\p{L}\p{N}]{1,16}$/u.test(path) ? path : '';
}

function pathMatches(text) {
  const matches = [], covered = [];
  const add = (start, end, value) => {
    if (covered.some(([from, to]) => start < to && end > from)) return;
    covered.push([start, end]);
    const path = normalizeTerminalDownloadPath(value);
    if (path) matches.push({ start, end, path });
  };
  // Reserve URLs too, so their path component never becomes a local file link.
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi)) {
    if (!/^file:/i.test(match[0])) covered.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(/\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/gu)) add(match.index, match.index + match[0].length, match[1]);
  for (const match of text.matchAll(/(["'`])([^\n]*?)\1|<([^<>\n]+)>/gu)) add(match.index, match.index + match[0].length, match[2] ?? match[3]);
  for (const match of text.matchAll(/[^\s<>"'`()\[\]{},;|，。；：]+/gu)) {
    const value = match[0].replace(/[.!]+$/, '');
    add(match.index, match.index + value.length, value);
  }
  return matches.sort((a, b) => a.start - b.start);
}

function logicalLine(buffer, row, cols, minRow = 0, maxRow = buffer.length - 1) {
  let start = row, end = row;
  while (start > minRow && buffer.getLine(start)?.isWrapped && row - start < 299) start--;
  while (end < maxRow && buffer.getLine(end + 1)?.isWrapped && end - start < 299) end++;
  let text = '';
  const positions = [];
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    let length = Math.min(cols || line.length, line.length);
    // Empty padding at a wrap boundary is common when the next glyph is wide.
    while (length > 0 && !line.getCell(length - 1)?.getChars() && line.getCell(length - 1)?.getWidth() !== 0) length--;
    for (let x = 0; x < length; x++) {
      const cell = line.getCell(x), width = cell?.getWidth() ?? 1;
      if (!width) continue;
      const chars = cell?.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) positions.push({ start: { x: x + 1, y: y + 1 }, end: { x: x + width, y: y + 1 } });
    }
  }
  return { text, positions, start, end };
}

export function createTerminalFileLinkProvider(term, onOpen) {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer?.active, row = bufferLineNumber - 1;
      if (!buffer || row < 0 || row >= buffer.length) return callback(undefined);
      const line = logicalLine(buffer, row, term.cols);
      const links = pathMatches(line.text).flatMap(match => {
        const start = line.positions[match.start]?.start, end = line.positions[match.end - 1]?.end;
        if (!start || !end || start.y > bufferLineNumber || end.y < bufferLineNumber) return [];
        return [{ text: line.text.slice(match.start, match.end), range: { start, end }, activate: () => { if (!term.hasSelection?.()) onOpen(match.path); } }];
      });
      callback(links.length ? links : undefined);
    },
  };
}

export function collectTerminalDownloadPaths(term, { limit = 30, maxLines = 300 } = {}) {
  const paths = [], seen = new Set(), buffers = [...new Set([term.buffer?.active, term.buffer?.normal].filter(Boolean))];
  limit = Math.max(0, Math.min(100, Math.floor(limit) || 0));
  let remaining = Math.max(0, Math.min(2000, Math.floor(maxLines) || 0));
  for (const buffer of buffers) {
    const minRow = Math.max(0, buffer.length - remaining);
    for (let row = buffer.length - 1; row >= minRow && paths.length < limit && remaining > 0;) {
      const line = logicalLine(buffer, row, term.cols, minRow);
      remaining -= row - line.start + 1;
      for (const { path } of pathMatches(line.text).reverse()) {
        if (seen.has(path)) continue;
        seen.add(path); paths.push(path);
        if (paths.length >= limit) break;
      }
      row = line.start - 1;
    }
  }
  return paths;
}
