import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const categories = [
  ['runtime', '运行时与扩展', '#438fed'], ['uploads', '上传文件', '#50b887'], ['history', '会话与数据库', '#9476dc'],
  ['cache', '缓存与临时文件', '#d5a04d'], ['logs', '日志', '#d66b72'], ['backups', '备份', '#48adad'], ['other', '其他', '#858585'],
];
const groups = [['services', '基础服务'], ['codex', 'Codex 与任务'], ['terminals', '终端会话']];
const percent = value => Math.max(0, Math.min(100, value));
async function parallelMap(values, operation, concurrency = 16) {
  let index = 0; const result = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) { const slot = index++; result[slot] = await operation(values[slot]); }
  }));
  return result;
}
export function parseProcessStat(text, pageSize = 4096) {
  const left = text.indexOf('('), right = text.lastIndexOf(')');
  const fields = text.slice(right + 2).trim().split(/\s+/);
  if (left < 0 || right < left || fields.length < 22) return null;
  return { pid: Number(text.slice(0, left).trim()), command: text.slice(left + 1, right), ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), start: fields[19], rss: Number(fields[21]) * pageSize };
}
function parseCpu(text) {
  const values = text.split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  return { total: values.reduce((a, b) => a + b, 0), idle: values[3] + values[4] };
}
function parseNetwork(text) {
  return text.split('\n').slice(2).flatMap(line => {
    const colon = line.indexOf(':'); if (colon < 0) return [];
    const name = line.slice(0, colon).trim(), fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    return name === 'lo' || fields.length < 16 ? [] : [{ name, received: fields[0], sent: fields[8] }];
  });
}
function safeUrl(value) {
  const url = new URL(value, 'http://local');
  for (const key of new Set(url.searchParams.keys())) {
    if (!['offset', 'limit', 'image', 'download'].includes(key) || !/^\d+$/.test(url.searchParams.get(key))) url.searchParams.set(key, '[已隐藏]');
  }
  return url.pathname + (url.search ? '?' + url.searchParams.toString() : '');
}

export function createResourceMonitor({ root, dataDir, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), rootPid = process.pid,
  getProcessRoles = () => new Map(), procRoot = '/proc', now = Date.now, pageSize } = {}) {
  const leases = new Map(), requests = []; let dropped = 0, sequence = 0;
  let previous = null, metricsCache = null, metricsPending = null, storageCache = null, storagePending = null;
  const constants = (async () => {
    async function number(name, fallback) { try { return Number((await execute('getconf', [name], { timeout: 1500 })).stdout.trim()) || fallback; } catch { return fallback; } }
    return { pageSize: pageSize || await number('PAGESIZE', 4096) };
  })();
  function hasObservers() {
    for (const [id, expires] of leases) if (expires <= now()) leases.delete(id);
    return leases.size > 0;
  }
  function touch(id) { if (typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)) leases.set(id, now() + 15000); }
  function observeRequests(req, res, next) {
    if (!hasObservers() || req.originalUrl.startsWith('/api/resources')) return next();
    const startedAt = now(), url = safeUrl(req.originalUrl), method = req.method;
    let recorded = false;
    function finish(aborted) {
      if (recorded) return; recorded = true;
      requests.unshift({ id: ++sequence, startedAt, pid: rootPid, process: '网页服务', method, url, status: aborted ? null : res.statusCode,
        durationMs: Math.max(0, now() - startedAt), requestBytes: Number(req.headers['content-length']) || 0, responseBytes: res.getHeader('content-length') == null ? null : Number(res.getHeader('content-length')) });
      if (requests.length > 1000) { requests.length = 1000; dropped++; }
    }
    res.once('finish', () => finish(false)); res.once('close', () => finish(!res.writableFinished)); next();
  }
  async function collectMetrics() {
    const constant = await constants;
    const [cpuText, memoryText, networkText, entries] = await Promise.all([
      fs.readFile(path.join(procRoot, 'stat'), 'utf8'), fs.readFile(path.join(procRoot, 'meminfo'), 'utf8'),
      fs.readFile(path.join(procRoot, 'net/dev'), 'utf8'), fs.readdir(procRoot),
    ]);
    const all = (await parallelMap(entries.filter(entry => /^\d+$/.test(entry)), async entry => {
      try { return parseProcessStat(await fs.readFile(path.join(procRoot, entry, 'stat'), 'utf8'), constant.pageSize); } catch { return null; }
    })).filter(Boolean);
    const byParent = new Map();
    for (const item of all) { if (!byParent.has(item.ppid)) byParent.set(item.ppid, []); byParent.get(item.ppid).push(item); }
    const roles = getProcessRoles(), own = all.find(item => item.pid === rootPid), selected = [], seen = new Set();
    const queue = own ? [{ ...own, group: 'services', name: '网页服务' }] : [];
    while (queue.length) {
      const item = queue.shift(); if (seen.has(item.pid)) continue; seen.add(item.pid);
      const role = roles.get(item.pid);
      if (role) { item.group = role.group; item.name = role.name; }
      selected.push(item);
      for (const child of byParent.get(item.pid) || []) queue.push({ ...child, group: item.group, name: child.command });
    }
    const timestamp = now(), cpu = parseCpu(cpuText), network = parseNetwork(networkText);
    const intervalMs = previous ? timestamp - previous.timestamp : 0, cpuDelta = previous ? cpu.total - previous.cpu.total : 0;
    const idleDelta = previous ? cpu.idle - previous.cpu.idle : 0;
    const processes = selected.map(item => {
      const before = previous?.processes.get(`${item.pid}:${item.start}`);
      return { pid: item.pid, name: item.name, command: item.command, rss: item.rss, group: item.group,
        cpuPercent: before !== undefined && cpuDelta > 0 ? percent((item.ticks - before) / cpuDelta * 100) : null };
    });
    const memory = Object.fromEntries([...memoryText.matchAll(/^(\w+):\s+(\d+)/gm)].map(match => [match[1], Number(match[2]) * 1024]));
    const interfaces = network.map(item => {
      const before = previous?.network.find(entry => entry.name === item.name);
      return { ...item, receivePerSecond: before && intervalMs > 0 ? Math.max(0, item.received - before.received) * 1000 / intervalMs : null,
        sendPerSecond: before && intervalMs > 0 ? Math.max(0, item.sent - before.sent) * 1000 / intervalMs : null };
    });
    previous = { timestamp, cpu, network, processes: new Map(selected.map(item => [`${item.pid}:${item.start}`, item.ticks])) };
    return { timestamp, intervalMs, pid: rootPid, processCount: processes.length, cores: os.cpus().length,
      cpu: { appPercent: cpuDelta > 0 ? percent(processes.reduce((sum, item) => sum + (item.cpuPercent || 0), 0)) : null,
        systemPercent: cpuDelta > 0 ? percent((1 - idleDelta / cpuDelta) * 100) : null },
      memory: { appRss: processes.reduce((sum, item) => sum + item.rss, 0), total: memory.MemTotal, available: memory.MemAvailable ?? memory.MemFree,
        used: memory.MemTotal - (memory.MemAvailable ?? memory.MemFree), swapUsed: (memory.SwapTotal || 0) - (memory.SwapFree || 0), swapTotal: memory.SwapTotal || 0 },
      network: { interfaces, receivePerSecond: intervalMs > 0 ? interfaces.reduce((sum, item) => sum + (item.receivePerSecond || 0), 0) : null,
        sendPerSecond: intervalMs > 0 ? interfaces.reduce((sum, item) => sum + (item.sendPerSecond || 0), 0) : null },
      groups: groups.map(([id, label]) => ({ id, label, processes: processes.filter(item => item.group === id) })).filter(group => group.processes.length) };
  }
  async function metrics() {
    if (metricsCache && now() - metricsCache.timestamp < 1000) return metricsCache;
    if (previous && now() - previous.timestamp > 10000) previous = null;
    if (!metricsPending) metricsPending = collectMetrics().then(value => { metricsCache = value; return value; }).finally(() => { metricsPending = null; });
    return metricsPending;
  }

  async function collectStorage() {
    const assignments = [], roots = [], visited = new Set();
    async function addDirectory(base, label, classify) {
      let entries, stat;
      try { entries = await fs.readdir(base, { withFileTypes: true }); stat = await fs.stat(base); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      roots.push({ path: base, label, dev: String(stat.dev), bytes: 0, categories: Object.fromEntries(categories.map(([id]) => [id, 0])) });
      for (const entry of entries) { const category = classify(entry.name); if (category) assignments.push({ path: path.join(base, entry.name), category, root: roots.length - 1 }); }
    }
    await addDirectory(root, '网页程序', name => name === '.data' || path.resolve(root, name) === path.resolve(dataDir) || path.resolve(root, name) === path.resolve(codexHome) || name === '.git' ? null : 'runtime');
    await addDirectory(dataDir, '网页数据', name => name === 'uploads' ? 'uploads' : name === 'uploading' ? 'cache' : /backup|rollback/i.test(name) ? 'backups' : /^state\.json|\.sqlite(?:-|$)/.test(name) ? 'history' : /\.log(?:\.|$)/.test(name) ? 'logs' : /dist|qa|test|probe|verify|\.png$|\.trace$/.test(name) ? 'cache' : 'other');
    await addDirectory(codexHome, 'Codex 数据', name => /^(sessions|archived_sessions)$|^history.*\.jsonl$|\.sqlite(?:-|$)/.test(name) ? 'history' : /^(log|logs)$/.test(name) ? 'logs' : /^(skills|plugins|extensions|bin|runtimes)$/.test(name) ? 'runtime' : /backup/.test(name) ? 'backups' : /^(tmp|cache|shell_snapshots|downloads)$/.test(name) ? 'cache' : 'other');
    const totals = Object.fromEntries(categories.map(([id]) => [id, 0])); let skipped = 0;
    await parallelMap(assignments, async assignment => {
      const pending = [assignment.path]; let bytes = 0;
      while (pending.length) {
        const filename = pending.pop();
        try {
          const stat = await fs.lstat(filename), identity = `${stat.dev}:${stat.ino}`;
          if (visited.has(identity)) continue; visited.add(identity);
          bytes += typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
          if (stat.isDirectory()) for (const entry of await fs.readdir(filename)) pending.push(path.join(filename, entry));
        } catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; skipped++; }
      }
      totals[assignment.category] += bytes; roots[assignment.root].bytes += bytes; roots[assignment.root].categories[assignment.category] += bytes;
    }, 4);
    const disks = [];
    for (const entry of roots) {
      if (disks.some(disk => disk.dev === entry.dev)) continue;
      const stat = await fs.statfs(entry.path);
      disks.push({ dev: entry.dev, path: entry.path, total: stat.blocks * stat.bsize, available: stat.bavail * stat.bsize, used: (stat.blocks - stat.bfree) * stat.bsize,
        appBytes: roots.filter(item => item.dev === entry.dev).reduce((sum, item) => sum + item.bytes, 0),
        categories: categories.map(([id, label, color]) => ({ id, label, color, bytes: roots.filter(item => item.dev === entry.dev).reduce((sum, item) => sum + item.categories[id], 0) })) });
    }
    return { timestamp: now(), total: Object.values(totals).reduce((sum, size) => sum + size, 0), categories: categories.map(([id, label, color]) => ({ id, label, color, bytes: totals[id] })), roots, disks, skipped };
  }
  async function storage(force = false) {
    if (!force && storageCache && now() - storageCache.timestamp < 60000) return storageCache;
    if (!storagePending) storagePending = collectStorage().then(value => { storageCache = value; return value; }).finally(() => { storagePending = null; });
    return storagePending;
  }
  const router = express.Router();
  router.post('/sessions', (req, res) => { hasObservers(); const id = randomUUID(); touch(id); res.json({ id }); });
  router.delete('/sessions/:id', (req, res) => { leases.delete(req.params.id); res.json({ ok: true }); });
  router.get('/metrics', async (req, res) => { touch(req.query.session); res.json(await metrics()); });
  router.get('/storage', async (req, res) => res.json(await storage()));
  router.post('/storage/recalculate', async (req, res) => res.json(await storage(true)));
  router.get('/requests', (req, res) => { touch(req.query.session); res.json({ items: requests, dropped, limit: 1000 }); });
  router.delete('/requests', (req, res) => { requests.length = 0; dropped = 0; res.json({ ok: true }); });
  return { router, observeRequests, metrics, storage };
}
