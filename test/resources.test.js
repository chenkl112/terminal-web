import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createResourceMonitor, parseProcessStat } from '../server/resources.js';

function stat(pid, parent, ticks, pages, start = 42, name = 'worker (test)') {
  const fields = new Array(22).fill('0'); fields[0] = 'S'; fields[1] = parent; fields[11] = ticks; fields[19] = start; fields[21] = pages;
  return `${pid} (${name}) ${fields.join(' ')}`;
}
test('resource samples isolate the process tree and compute CPU and network deltas without PID reuse spikes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mono-resource-proc-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'net'));
  let clock = 10000;
  async function writeSample(second, reused = false) {
    await fs.writeFile(path.join(dir, 'stat'), second ? 'cpu 130 0 120 950 0 0 0 0 0 0\n' : 'cpu 100 0 100 800 0 0 0 0 0 0\n');
    await fs.writeFile(path.join(dir, 'meminfo'), 'MemTotal: 1000000 kB\nMemAvailable: 600000 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\n');
    await fs.writeFile(path.join(dir, 'net/dev'), `header\nheader\nlo: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0\nenp1: ${second ? 5000 : 1000} 0 0 0 0 0 0 0 ${second ? 8000 : 2000} 0 0 0 0 0 0 0\n`);
    for (const [pid, parent, ticks, pages, increment] of [[100, 1, 10, 10, 4], [200, 100, 20, 20, 6], [201, 200, 5, 5, 2], [300, 100, 8, 8, 4], [301, 300, 2, 2, 4], [999, 1, 9000, 500, 500]]) {
      await fs.mkdir(path.join(dir, String(pid)), { recursive: true });
      await fs.writeFile(path.join(dir, String(pid), 'stat'), stat(pid, parent, reused && pid === 301 ? 9999 : ticks + (second ? increment : 0), pages, reused && pid === 301 ? 99 : 42));
    }
  }
  await writeSample(false);
  const monitor = createResourceMonitor({ root: dir, dataDir: dir, procRoot: dir, rootPid: 100, now: () => clock, pageSize: 4096,
    getProcessRoles: () => new Map([[200, { group: 'codex', name: 'Codex 服务' }], [300, { group: 'terminals', name: 'Codex 终端' }]]) });
  const initial = await monitor.metrics(); assert.equal(initial.cpu.appPercent, null); assert.equal(initial.cpu.systemPercent, null);
  assert.equal(initial.processCount, 5); assert.equal(initial.memory.appRss, 45 * 4096); assert.equal(initial.memory.used, 400000 * 1024);
  assert.deepEqual(initial.groups.map(group => group.processes.length), [1, 2, 2]); assert.equal(JSON.stringify(initial).includes('999,'), false);
  await writeSample(true); assert.equal((await monitor.metrics()).cpu.appPercent, null); clock += 2000;
  const [sample, simultaneous] = await Promise.all([monitor.metrics(), monitor.metrics()]);
  assert.equal(sample.cpu.appPercent, 10); assert.equal(sample.cpu.systemPercent, 25); assert.deepEqual(sample, simultaneous);
  assert.equal(sample.network.receivePerSecond, 2000); assert.equal(sample.network.sendPerSecond, 3000); assert.equal(sample.network.interfaces.length, 1);
  clock += 2000; await writeSample(true, true);
  const reused = await monitor.metrics(); assert.equal(reused.groups.flatMap(group => group.processes).find(item => item.pid === 301).cpuPercent, null);
  clock += 20000; const reopened = await monitor.metrics(); assert.equal(reopened.cpu.appPercent, null); assert.equal(reopened.network.receivePerSecond, null);
  assert.equal(parseProcessStat(stat(1, 0, 10, 2)).command, 'worker (test)');
});

test('storage counts allocated files by category, skips symlink targets and deduplicates hardlinks', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mono-resource-storage-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'app'), dataDir = path.join(root, '.data'), codexHome = path.join(base, 'codex');
  for (const name of [path.join(root, 'node_modules'), path.join(dataDir, 'uploads'), path.join(dataDir, 'backups'), path.join(codexHome, 'sessions')]) await fs.mkdir(name, { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'runtime'), Buffer.alloc(8192)); await fs.writeFile(path.join(dataDir, 'state.json'), '{}');
  await fs.writeFile(path.join(dataDir, 'uploads', 'file'), Buffer.alloc(131072)); await fs.link(path.join(dataDir, 'uploads', 'file'), path.join(dataDir, 'uploads', 'hardlink'));
  await fs.writeFile(path.join(base, 'outside'), Buffer.alloc(1024 * 1024)); await fs.symlink(path.join(base, 'outside'), path.join(dataDir, 'uploads', 'link'));
  await fs.writeFile(path.join(codexHome, 'sessions', 'turn.jsonl'), 'history'); await fs.writeFile(path.join(codexHome, 'auth.json'), 'SECRET_CREDENTIAL_VALUE');
  const monitor = createResourceMonitor({ root, dataDir, codexHome, pageSize: 4096 }); const first = await monitor.storage();
  const uploaded = first.categories.find(category => category.id === 'uploads').bytes; assert.ok(uploaded >= 131072 && uploaded < 200000);
  assert.equal(first.categories.reduce((sum, category) => sum + category.bytes, 0), first.total);
  assert.equal(first.roots.reduce((sum, root) => sum + root.bytes, 0), first.total); assert.equal(first.disks.reduce((sum, disk) => sum + disk.appBytes, 0), first.total);
  assert.equal(JSON.stringify(first).includes('SECRET_CREDENTIAL_VALUE'), false); assert.equal(JSON.stringify(first).includes('auth.json'), false);
  await fs.writeFile(path.join(dataDir, 'uploads', 'new'), Buffer.alloc(65536)); assert.equal((await monitor.storage()).total, first.total);
  const recalculated = await monitor.storage(true); assert.ok(recalculated.total >= first.total + 65536);
  assert.ok(recalculated.disks.every(disk => disk.total > disk.available && disk.total > 0));
});

test('request diagnostics record only while observed, redact secrets, cap at 1000 and retain the auth boundary', async t => {
  const monitor = createResourceMonitor({ pageSize: 4096 }); const app = express();
  app.use(express.json()); app.use('/api', (req, res, next) => req.headers.authorization === 'test' ? next() : res.status(401).json({ error: 'unauthorized' }));
  app.use('/api', monitor.observeRequests); app.use('/api/resources', monitor.router); app.all('/api/ping', (req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (route, method = 'GET') => fetch(origin + route, { method, headers: { authorization: 'test', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{"private":"BODY_SECRET"}' } : {}) });
  assert.equal((await fetch(origin + '/api/resources/metrics')).status, 401);
  await call('/api/ping'); assert.equal((await (await call('/api/resources/requests')).json()).items.length, 0);
  const session = await (await call('/api/resources/sessions', 'POST')).json();
  await call('/api/ping?api_key=URL_SECRET&offset=12', 'POST');
  let log = await (await call('/api/resources/requests')).json(); assert.equal(log.items.length, 1); assert.equal(log.items[0].status, 200);
  assert.equal(log.items[0].method, 'POST'); assert.ok(log.items[0].url.includes('offset=12')); assert.equal(/URL_SECRET|BODY_SECRET/.test(JSON.stringify(log)), false);
  for (let batch = 0; batch < 21; batch++) await Promise.all(Array.from({ length: 50 }, () => call('/api/ping')));
  log = await (await call('/api/resources/requests')).json(); assert.equal(log.items.length, 1000); assert.equal(log.dropped, 51);
  await call(`/api/resources/sessions/${session.id}`, 'DELETE'); await call('/api/ping');
  assert.equal((await (await call('/api/resources/requests')).json()).dropped, 51);
  await call('/api/resources/requests', 'DELETE'); assert.equal((await (await call('/api/resources/requests')).json()).items.length, 0);
});
