import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const idsIn = text => text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ig) || [];

export function uploadCleanupSettings(env = process.env) {
  const number = (key, fallback, min) => {
    if (env[key] === undefined || env[key] === '') return fallback;
    const value = Number(env[key]);
    if (!Number.isFinite(value) || value < min) throw new Error(`${key} 配置无效`);
    return value;
  };
  return { retentionMs: number('UPLOAD_UNUSED_DAYS', 7, 0) * DAY,
    intervalMs: number('UPLOAD_CLEANUP_INTERVAL_MINUTES', 60, 1) * 60000 };
}

// Only registered, completed uploads are eligible. Partial/folder staging is untouched.
export function createUploadCleanup({ state, uploadDir, codexHome, save,
  retentionMs = 7 * DAY, intervalMs = 3600000, now = Date.now, logger = console }) {
  const trashDir = path.join(path.dirname(uploadDir), 'upload-trash');
  const historyCache = new Map();
  let timer, startupTimer, running, stopped = false;

  function markUsed(ids) {
    let changed = false;
    for (const id of ids) {
      const file = Object.hasOwn(state.uploads, id) && state.uploads[id];
      if (file && !file.usedAt) { file.usedAt = now(); changed = true; }
    }
    if (changed) save(true);
  }
  function touch(ids) {
    let changed = false;
    for (const id of ids) {
      const file = Object.hasOwn(state.uploads, id) && state.uploads[id];
      if (file && !file.usedAt) { file.lastAccessedAt = now(); changed = true; }
    }
    if (changed) save();
  }
  function markConversationReferences() {
    // Includes archived conversations, native message paths and pending turn attachments.
    markUsed(idsIn(JSON.stringify(state.conversations)));
  }

  async function scanHistory(directory, seen, used) {
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (stopped) return;
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('历史目录包含符号链接，跳过清理');
      if (entry.isDirectory()) await scanHistory(filename, seen, used);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        seen.add(filename);
        const stat = await fs.promises.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('历史文件类型发生变化');
        const previous = historyCache.get(filename);
        if (previous?.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ino === stat.ino) {
          for (const id of previous.ids) used.add(id);
          continue;
        }
        const start = previous?.ino === stat.ino && stat.size > previous.size ? Math.max(0, previous.size - 72) : 0;
        const found = new Set(start ? previous.ids : []);
        if (stat.size) {
          const stream = fs.createReadStream(filename, { start, end: stat.size - 1, encoding: 'utf8', highWaterMark: 256 * 1024 });
          let tail = '';
          for await (const chunk of stream) {
            if (stopped) { stream.destroy(); return; }
            const text = tail + chunk;
            for (const id of idsIn(text)) found.add(id);
            tail = text.slice(-72);
          }
        }
        for (const id of found) used.add(id);
        historyCache.set(filename, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, ids: found });
      }
    }
  }

  async function recoverTrash() {
    for (const entry of await fs.promises.readdir(trashDir, { withFileTypes: true })) {
      if (stopped) return;
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const source = path.join(trashDir, entry.name), destination = path.join(uploadDir, entry.name);
      if (Object.hasOwn(state.uploads, entry.name)) {
        // A crash before the state commit leaves a recoverable registered upload.
        if (!fs.existsSync(destination)) fs.renameSync(source, destination);
      } else await fs.promises.rm(source, { recursive: true, force: true });
    }
  }

  async function sweep() {
    if (retentionMs === 0 || stopped) return { removed: 0, bytes: 0 };
    for (const directory of [uploadDir, trashDir]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('上传清理目录不能是符号链接');
    }
    await recoverTrash();
    markConversationReferences();
    const seen = new Set(), used = new Set();
    if (codexHome) {
      for (const name of ['sessions', 'archived_sessions']) {
        const directory = path.join(codexHome, name);
        if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('历史目录不能是符号链接');
        await scanHistory(directory, seen, used);
      }
    }
    for (const key of historyCache.keys()) if (!seen.has(key)) historyCache.delete(key);
    markUsed(used);
    // Recheck after asynchronous history I/O, immediately before moving eligible files.
    markConversationReferences();
    const removed = [];
    if (stopped) return { removed: 0, bytes: 0 };
    try {
      for (const [id, file] of Object.entries(state.uploads)) {
        const timestamp = Math.max(file.uploadedAt || 0, file.lastAccessedAt || 0);
        if (!UUID.test(id) || file.id !== id || file.usedAt || !Number.isFinite(timestamp) || timestamp <= 0 || now() - timestamp < retentionMs) continue;
        const directory = path.join(uploadDir, id), trash = path.join(trashDir, id);
        if (typeof file.path !== 'string' || path.dirname(path.resolve(file.path)) !== directory || fs.existsSync(trash)) continue;
        // Never follow an upload record into arbitrary project paths or symlinks.
        let stat;
        try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        fs.renameSync(directory, trash);
        delete state.uploads[id];
        removed.push(file);
      }
      // Commit once: the conversation state can be large, so avoid rewriting it per file.
      if (removed.length) save(true);
    } catch (error) {
      for (const file of removed) {
        state.uploads[file.id] = file;
        fs.renameSync(path.join(trashDir, file.id), path.join(uploadDir, file.id));
      }
      throw error;
    }
    // Removing large folders is asynchronous so chat and terminal output remain responsive.
    for (const file of removed) await fs.promises.rm(path.join(trashDir, file.id), { recursive: true, force: true });
    const result = { removed: removed.length, bytes: removed.reduce((sum, file) => sum + (Number(file.size) || 0), 0) };
    if (result.removed) logger.info('Unused uploads cleaned', result);
    return result;
  }

  function run() {
    if (!running) running = sweep().finally(() => { running = null; });
    return running;
  }
  function start() {
    if (timer || retentionMs === 0 || stopped) return;
    const check = () => run().catch(error => logger.error('上传清理已跳过:', error.message));
    startupTimer = setTimeout(check, 60000); startupTimer.unref();
    timer = setInterval(check, intervalMs); timer.unref();
    logger.info('Upload cleanup enabled', { unusedDays: retentionMs / DAY, intervalMinutes: intervalMs / 60000 });
  }
  function stop() { stopped = true; clearTimeout(startupTimer); clearInterval(timer); }
  return { run, start, stop, touch, markUsed, markTextUsed: text => markUsed(idsIn(text)) };
}
