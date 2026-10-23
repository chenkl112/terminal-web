const CHUNK_SIZE = 8 * 1024 * 1024;

export function uploadId() {
  // randomUUID is unavailable on HTTP LAN origins in Chromium/Edge.
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, digit =>
    (Number(digit) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(digit) / 4).toString(16));
}

class UploadError extends Error {
  constructor(message, status = 0, data = {}) { super(message); this.status = status; this.data = data; }
  get retryable() { return !this.status || [408, 409, 429].includes(this.status) || this.status >= 500; }
}
const cancelled = () => new DOMException('上传已取消', 'AbortError');
function request(url, { method = 'GET', body, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error, value) => {
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    xhr.open(method, url);
    if (body instanceof ArrayBuffer || body instanceof Blob) xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    else if (body !== undefined) { xhr.setRequestHeader('Content-Type', 'application/json'); body = JSON.stringify(body); }
    if (onProgress) xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded); };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { return finish(new UploadError('服务器响应异常，请刷新后重试', xhr.status || 502)); }
      if (xhr.status >= 200 && xhr.status < 300) finish(null, data);
      else finish(new UploadError(data.error || '上传失败，请重试', xhr.status, data));
    };
    xhr.onerror = () => finish(new UploadError('无法连接本机上传服务，请检查网络后重试'));
    xhr.onabort = () => finish(cancelled());
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(body);
  });
}
function pause(signal, delay) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function retry(operation, signal) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!error.retryable || attempt === 3) throw error;
      await pause(signal, 300 * 2 ** attempt);
    }
  }
}

export async function sendFile(file, { signal, onProgress = () => {}, onTransfer = () => {}, parentId } = {}) {
  const base = `/api/uploads/${file.id}`;
  const initial = await retry(() => request('/api/uploads/start', { method: 'POST', signal,
    body: { id: file.id, name: file.name, size: file.size, type: file.raw.type || '', ...(parentId ? { parentId } : {}) } }), signal);
  if (initial.attachment) return initial.attachment;
  // Older servers accept 8 MiB; streaming servers advertise larger chunks.
  const chunkSize = Number.isSafeInteger(initial.chunkSize) && initial.chunkSize > 0 ? Math.min(initial.chunkSize, 32 * 1024 * 1024) : CHUNK_SIZE;
  let offset = initial.offset;
  onProgress(offset);
  while (offset < file.size) {
    if (signal?.aborted) throw cancelled();
    let content;
    // XHR can read a Blob directly, avoiding an extra file copy into JavaScript memory.
    try { content = file.raw.slice(offset, offset + chunkSize); }
    catch { throw new Error('无法读取源文件，请确认文件仍在原位置，然后重新添加'); }
    if (!content.size) throw new Error('源文件已发生变化，请重新添加');
    const start = offset;
    const result = await retry(async () => {
      let sent = 0;
      const transferred = loaded => {
        onTransfer(Math.max(0, loaded - sent));
        sent = Math.max(sent, loaded);
        onProgress(start + loaded);
      };
      try {
        const saved = await request(`${base}/content?offset=${start}`, { method: 'PUT', body: content, signal, onProgress: transferred });
        transferred(content.size);
        return saved;
      }
      catch (error) {
        if (!error.retryable) throw error;
        // A lost response may still have saved the chunk. Ask before sending it again.
        const saved = await request(`${base}/status`, { signal });
        if (saved.offset !== start) return saved;
        throw error;
      }
    }, signal);
    if (!Number.isSafeInteger(result.offset) || result.offset <= start || result.offset > file.size) throw new Error('服务器上传进度异常，请重试');
    offset = result.offset;
    onProgress(offset);
  }
  return retry(() => request(`${base}/complete`, { method: 'POST', body: {}, signal }), signal);
}

export async function sendFolder(folder, { signal, onProgress = () => {}, onTransfer = () => {} } = {}) {
  const base = `/api/uploads/${folder.id}`;
  const initial = await retry(() => request('/api/uploads/start', { method: 'POST', signal,
    body: { id: folder.id, kind: 'folder', name: folder.name, size: folder.size, type: '',
      fileCount: folder.files.length, directoryCount: folder.directories.length } }), signal);
  if (initial.attachment) return initial.attachment;
  const entries = new Set(initial.entries || []);
  const addEntry = body => retry(() => request(`${base}/entries`, { method: 'POST', body, signal }), signal);
  for (const relativePath of folder.directories) {
    if (!entries.has(relativePath)) await addEntry({ relativePath, directory: true });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let loaded = folder.files.reduce((sum, file) => sum + (entries.has(file.relativePath) ? file.size : 0), 0);
  const progress = new Map();
  const pendingFiles = folder.files.filter(file => !entries.has(file.relativePath));
  let index = 0, failure;
  onProgress(loaded);
  async function worker() {
    try {
      while (index < pendingFiles.length && !controller.signal.aborted) {
        const file = pendingFiles[index++];
        const uploaded = await sendFile(file, { signal: controller.signal, onTransfer, ...(initial.stagedFiles ? { parentId: folder.id } : {}), onProgress: value => {
          const next = Math.max(progress.get(file.id) || 0, value);
          loaded += next - (progress.get(file.id) || 0); progress.set(file.id, next);
          onProgress(loaded);
        } });
        await retry(() => request(`${base}/entries`, { method: 'POST', body: { relativePath: file.relativePath, uploadId: uploaded.id }, signal: controller.signal }), controller.signal);
        loaded += file.size - (progress.get(file.id) || 0); progress.delete(file.id);
        onProgress(loaded);
      }
    } catch (error) { failure ||= error; controller.abort(); }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(3, pendingFiles.length) }, worker));
    if (failure) throw failure;
    if (controller.signal.aborted) throw cancelled();
  } finally { signal?.removeEventListener('abort', abort); }
  return retry(() => request(`${base}/complete`, { method: 'POST', body: {}, signal }), signal);
}

function describe(raw, relativePath) {
  return { id: uploadId(), raw, name: raw.name, size: raw.size, relativePath };
}
const getFile = entry => new Promise((resolve, reject) => entry.file(resolve, reject));
async function walkDirectory(entry, prefix, files, directories) {
  const reader = entry.createReader();
  // Chromium returns directory entries in batches (often only 100 at a time).
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) {
      const relativePath = prefix + child.name;
      if (child.isDirectory) {
        directories.push(relativePath);
        await walkDirectory(child, relativePath + '/', files, directories);
      } else if (child.isFile) files.push(describe(await getFile(child), relativePath));
    }
  }
}
export function folderFromFiles(incoming) {
  const rawFiles = Array.from(incoming);
  if (!rawFiles.length) return [];
  if (!rawFiles[0].webkitRelativePath) return rawFiles.map(raw => describe(raw));
  const name = rawFiles[0].webkitRelativePath.split('/')[0];
  const files = [], directories = new Set();
  for (const raw of rawFiles) {
    const relativePath = raw.webkitRelativePath.slice(name.length + 1);
    files.push(describe(raw, relativePath));
    const parts = relativePath.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'));
  }
  return [{ id: uploadId(), kind: 'folder', name, files, directories: [...directories], size: files.reduce((sum, file) => sum + file.size, 0) }];
}
export async function droppedFiles(transfer) {
  // Capture entries synchronously: the browser clears DataTransfer after drop returns.
  const entries = Array.from(transfer.items || []).filter(item => item.kind === 'file').map(item => ({
    entry: item.webkitGetAsEntry?.(), raw: item.getAsFile(),
  }));
  if (!entries.length) return Array.from(transfer.files).map(raw => describe(raw));
  const result = [];
  for (const { entry, raw } of entries) {
    if (entry?.isDirectory) {
      const files = [], directories = [];
      await walkDirectory(entry, '', files, directories);
      result.push({ id: uploadId(), kind: 'folder', name: entry.name, files, directories,
        size: files.reduce((sum, file) => sum + file.size, 0) });
    } else if (raw) result.push(describe(raw));
  }
  return result;
}
