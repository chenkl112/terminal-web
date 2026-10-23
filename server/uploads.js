import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function diskName(name) {
  let value = path.basename(name).replace(/[\\/\x00-\x1f\x7f]/g, '_');
  while (Buffer.byteLength(value) > 180) value = Array.from(value).slice(0, -1).join('');
  return value && value !== '.' && value !== '..' ? value : 'file';
}

export function uploadRouter({ uploadDir, uploads, save }) {
  const router = express.Router();
  const incoming = path.join(path.dirname(uploadDir), 'uploading');
  fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
  const busy = new Set();
  const validId = id => /^[a-f0-9-]{36}$/i.test(id);
  const location = id => path.join(incoming, id);
  const read = id => {
    if (!validId(id)) throw Object.assign(new Error('上传记录不存在，请重新添加文件'), { status: 404 });
    try { return JSON.parse(fs.readFileSync(path.join(location(id), 'metadata.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('上传记录不存在，请重新添加文件'), { status: 404 });
      throw error;
    }
  };
  const payloadPath = meta => {
    const partial = path.join(location(meta.id), meta.kind === 'folder' ? 'tree' : 'content.part');
    return fs.existsSync(partial) ? partial : path.join(uploadDir, meta.id, diskName(meta.name));
  };
  const status = meta => meta.kind === 'folder'
    ? { id: meta.id, entries: Object.keys(meta.entries), size: meta.size, stagedFiles: true }
    : { id: meta.id, offset: fs.statSync(payloadPath(meta)).size, size: meta.size, chunkSize: 32 * 1024 * 1024 };
  const writeMeta = meta => {
    const target = path.join(location(meta.id), 'metadata.json');
    fs.writeFileSync(target + '.tmp', JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
  };
  const attachment = (meta, filePath) => ({ ...meta, path: filePath,
    image: /^image\/(png|jpeg|webp|gif)$/.test(meta.type) && /\.(png|jpe?g|webp|gif)$/i.test(filePath),
    url: `/api/uploads/${meta.id}`, uploadedAt: Date.now() });
  router.use((req, res, next) => {
    req.on('aborted', () => console.warn('Upload request aborted', req.method, req.path));
    next();
  });

  // The client reuses its ID when a response is lost. No file-size limit is applied.
  router.post('/start', (req, res) => {
    const { id, name, size, type, kind, fileCount, directoryCount, parentId } = req.body || {};
    if (!validId(id) || typeof name !== 'string' || !name || !Number.isSafeInteger(size) || size < 0 || typeof type !== 'string') {
      return res.status(400).json({ error: '文件信息无效，请重新添加文件' });
    }
    if (kind === 'folder' && (![fileCount, directoryCount].every(value => Number.isSafeInteger(value) && value >= 0))) return res.status(400).json({ error: '文件夹信息无效' });
    if (parentId !== undefined && (kind === 'folder' || !validId(parentId) || read(parentId).kind !== 'folder')) return res.status(400).json({ error: '文件夹上传记录无效' });
    if (uploads[id]) return res.json({ attachment: uploads[id], offset: uploads[id].size });
    if (busy.has(id)) return res.status(409).json({ error: '文件仍在保存，请稍后重试' });
    if (fs.existsSync(location(id))) {
      const meta = read(id);
      if (meta.name !== name || meta.size !== size || meta.type !== type || meta.kind !== kind || meta.fileCount !== fileCount || meta.directoryCount !== directoryCount || meta.parentId !== parentId) return res.status(409).json({ error: '文件信息不匹配，请重新添加文件' });
      if (meta.completed) return res.json({ attachment: meta.completed, offset: meta.size });
      return res.json(status(meta));
    }
    fs.mkdirSync(location(id), { mode: 0o700 });
    try {
      if (kind === 'folder') fs.mkdirSync(path.join(location(id), 'tree'), { mode: 0o700 });
      else fs.writeFileSync(path.join(location(id), 'content.part'), '', { mode: 0o600 });
      writeMeta({ id, name, size, type, ...(parentId ? { parentId } : {}), ...(kind === 'folder' ? { kind, fileCount, directoryCount, entries: {} } : {}) });
    } catch (error) { fs.rmSync(location(id), { recursive: true, force: true }); throw error; }
    res.status(201).json(status(read(id)));
  });
  router.get('/:id/status', (req, res) => {
    if (uploads[req.params.id]) return res.json({ attachment: uploads[req.params.id], offset: uploads[req.params.id].size });
    if (busy.has(req.params.id)) return res.status(409).json({ error: '文件仍在保存，请稍后重试' });
    const meta = read(req.params.id);
    res.json(meta.completed ? { attachment: meta.completed, offset: meta.size } : status(meta));
  });
  // Stream through bounded buffers so network transfer and disk writes can overlap.
  router.put('/:id/content', async (req, res) => {
    const meta = read(req.params.id);
    if (meta.kind === 'folder') return res.status(400).json({ error: '文件夹需要逐个上传内部文件' });
    const offset = Number(req.query.offset);
    if (busy.has(meta.id)) return res.status(409).json({ error: '正在保存上一段文件，请重试' });
    const current = status(meta);
    if (!Number.isSafeInteger(offset) || offset !== current.offset) return res.status(409).json({ ...current, error: '上传进度已更新' });
    const length = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
    if (!req.is('application/octet-stream') || length !== null && (!Number.isSafeInteger(length) || length <= 0 || offset + length > meta.size)) return res.status(400).json({ error: '文件片段无效' });
    let received = 0;
    const target = payloadPath(meta);
    busy.add(meta.id);
    try {
      try {
        await pipeline(req, new Transform({
          highWaterMark: 256 * 1024,
          transform(chunk, encoding, callback) {
            received += chunk.length;
            if (offset + received > meta.size) return callback(Object.assign(new Error('文件片段超出声明大小'), { status: 400 }));
            callback(null, chunk);
          },
        }), fs.createWriteStream(target, { flags: 'a', highWaterMark: 1024 * 1024 }));
        if (!received || length !== null && received !== length) throw Object.assign(new Error('文件片段不完整，请重试'), { status: 400 });
      } catch (error) {
        await fs.promises.truncate(target, offset);
        throw error;
      }
      res.json(status(meta));
    } finally { busy.delete(meta.id); }
  });
  router.post('/:id/entries', (req, res) => {
    const meta = read(req.params.id);
    if (meta.kind !== 'folder') return res.status(400).json({ error: '此附件不是文件夹' });
    const { relativePath, directory, uploadId } = req.body || {};
    if (typeof relativePath !== 'string' || !relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f\x7f]/.test(relativePath)) return res.status(400).json({ error: '文件夹内部路径无效' });
    if (Object.hasOwn(meta.entries, relativePath)) return res.json({ ok: true });
    const destination = path.join(payloadPath(meta), relativePath);
    if (directory) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      Object.defineProperty(meta.entries, relativePath, { value: { directory: true }, enumerable: true });
    } else {
      let source = uploads[uploadId], staged = false;
      if (!source && validId(uploadId)) {
        const child = read(uploadId);
        if (child.parentId === meta.id && child.completed) { source = child.completed; staged = true; }
      }
      if (!source || source.kind === 'folder') return res.status(400).json({ error: '文件尚未上传完成' });
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      try { fs.linkSync(source.path, destination); }
      catch (error) {
        // Retry safely if the entry was linked before its metadata was saved.
        if (error.code !== 'EEXIST' || fs.statSync(source.path).ino !== fs.statSync(destination).ino) throw error;
      }
      Object.defineProperty(meta.entries, relativePath, { value: { size: source.size, uploadId }, enumerable: true });
      if (staged) {
        // Commit the folder link before removing the child's independently resumable record.
        writeMeta(meta);
        fs.rmSync(path.join(uploadDir, uploadId), { recursive: true, force: true });
        fs.rmSync(location(uploadId), { recursive: true, force: true });
        return res.json({ ok: true });
      }
    }
    writeMeta(meta);
    res.json({ ok: true });
  });
  router.post('/:id/complete', (req, res) => {
    const id = req.params.id;
    if (uploads[id]) return res.json(uploads[id]);
    const meta = read(id);
    if (meta.completed) return res.json(meta.completed);
    if (busy.has(id)) return res.status(409).json({ error: '文件仍在保存，请稍后重试' });
    if (meta.kind === 'folder') {
      const values = Object.values(meta.entries);
      const files = values.filter(entry => !entry.directory);
      if (files.length !== meta.fileCount || values.length - files.length !== meta.directoryCount || files.reduce((sum, file) => sum + file.size, 0) !== meta.size) return res.status(409).json({ error: '文件夹尚未上传完成' });
    } else if (status(meta).offset !== meta.size) return res.status(409).json({ error: '文件尚未上传完成' });
    const dir = path.join(uploadDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const destination = path.join(dir, diskName(meta.name));
    const source = payloadPath(meta);
    if (source !== destination) fs.renameSync(source, destination);
    const { entries, ...publicMeta } = meta;
    if (meta.parentId) {
      const completed = attachment(publicMeta, destination);
      writeMeta({ ...meta, completed });
      return res.status(201).json(completed);
    }
    uploads[id] = attachment(publicMeta, destination);
    try { save(true); } catch (error) { delete uploads[id]; throw error; }
    fs.rmSync(location(id), { recursive: true, force: true });
    console.info('Upload completed', id, meta.size);
    res.status(201).json(uploads[id]);
  });
  router.delete('/:id', (req, res) => {
    if (!validId(req.params.id)) return res.status(400).end();
    if (busy.has(req.params.id)) return res.status(409).json({ error: '文件正在保存，请稍后重试' });
    fs.rmSync(location(req.params.id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  // Keep the streaming multipart endpoint for already-open browser tabs.
  const legacy = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => {
      req.uploadId = randomUUID();
      req.uploadPath = path.join(uploadDir, req.uploadId);
      fs.mkdir(req.uploadPath, { mode: 0o700 }, error => cb(error, req.uploadPath));
    },
    filename: (req, file, cb) => {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      file.displayName = name.includes('\uFFFD') ? file.originalname : name;
      cb(null, diskName(file.displayName));
    },
  }), limits: { files: 1 } });
  router.post('/', (req, res, next) => {
    legacy.single('file')(req, res, error => {
      if (error) {
        if (req.uploadPath) fs.rmSync(req.uploadPath, { recursive: true, force: true });
        return next(error);
      }
      if (!req.file) return res.status(400).json({ error: '没有收到文件' });
      try {
        const file = req.file;
        const value = attachment({ id: req.uploadId, name: file.displayName, size: file.size, type: file.mimetype }, file.path);
        uploads[value.id] = value;
        save(true);
        res.status(201).json(value);
      } catch (error) { next(error); }
    });
  });
  router.get('/:id', (req, res) => {
    const value = uploads[req.params.id];
    if (!value) return res.status(404).end();
    if (value.kind === 'folder') return res.json({ name: value.name, fileCount: value.fileCount,
      files: fs.readdirSync(value.path, { recursive: true }) });
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    if (value.image) res.type(value.type).sendFile(value.path);
    else res.download(value.path, value.name);
  });
  router.use((error, req, res, next) => {
    console.error('Upload failed', req.method, req.path, error.code || error.name, error.message);
    const message = error.code === 'ENOSPC' ? '本机磁盘空间不足，请清理后重试'
      : error.code === 'EACCES' ? '本机上传目录无法写入，请检查目录权限'
      : error.type === 'entity.too.large' ? '上传片段过大，请刷新页面后重试'
      : error.status && error.status < 500 ? error.message : '本机保存文件失败，请重试';
    if (!res.headersSent && !res.destroyed) res.status(error.status || 500).json({ error: message });
  });
  return router;
}
