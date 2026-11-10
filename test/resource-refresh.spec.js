import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const metrics = appPercent => ({
  timestamp: Date.now(), cores: 8, processCount: 1,
  cpu: { appPercent, systemPercent: 25 },
  memory: { appRss: 512 * 1024 ** 2, used: 2 * 1024 ** 3, total: 8 * 1024 ** 3 },
  network: { receivePerSecond: 1024, sendPerSecond: 512, interfaces: [] },
  groups: [{ id: 'server', label: '基础服务', processes: [{ pid: 42, name: 'node', command: 'node server/index.js', rss: 512 * 1024 ** 2, cpuPercent: appPercent }] }],
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const resourceButton = page => page.getByRole('button', { name: '资源管理器', exact: true });
const resourceDialog = page => page.getByRole('dialog', { name: '资源管理器', exact: true });
const waitForCount = (entries, count) => expect.poll(() => entries.length, { intervals: [50], timeout: 8000 }).toBeGreaterThanOrEqual(count);
const expectOneSecondCadence = entries => {
  const intervals = entries.slice(1).map((entry, index) => entry - entries[index]);
  for (const interval of intervals) expect(interval).toBeGreaterThanOrEqual(850);
  expect(intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length).toBeLessThan(1450);
};

async function withResourceServer(page, run) {
  const state = { metricsStarts: [], requestStarts: [], storageStarts: [], requestItems: [], abortedRequests: 0, activeMetrics: 0, maxActiveMetrics: 0, sessions: 0, closedSessions: 0, value: 12.5, storageValue: 1024, failMetrics: false, metricsGate: null, sessionGate: null, storageGate: null, requestsGate: null };
  const app = express(); app.use(express.json());
  app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.get('/api/resources/metrics', async (_, res) => {
    state.metricsStarts.push(Date.now());
    state.maxActiveMetrics = Math.max(state.maxActiveMetrics, ++state.activeMetrics);
    let finished = false;
    const finish = () => { if (!finished) { finished = true; state.activeMetrics--; } };
    res.once('finish', finish); res.once('close', finish);
    const gate = state.metricsGate;
    if (gate) await gate.promise;
    if (res.destroyed) return;
    if (state.failMetrics) res.status(503).json({ error: 'temporary fixture failure' });
    else res.json(metrics(state.value));
  });
  app.post('/api/resources/sessions', async (_, res) => {
    const id = `resource-session-${++state.sessions}`;
    if (state.sessionGate) await state.sessionGate.promise;
    if (!res.destroyed) res.json({ id });
  });
  app.delete('/api/resources/sessions/:id', (_, res) => { state.closedSessions++; res.json({ ok: true }); });
  app.get('/api/resources/requests', async (_, res) => {
    state.requestStarts.push(Date.now());
    res.once('close', () => { if (!res.writableFinished) state.abortedRequests++; });
    if (state.requestsGate) await state.requestsGate.promise;
    if (!res.destroyed) res.json({ items: state.requestItems, dropped: 0 });
  });
  app.get('/api/resources/storage', async (_, res) => {
    state.storageStarts.push(Date.now());
    if (state.storageGate) await state.storageGate.promise;
    if (!res.destroyed) res.json({ total: state.storageValue, timestamp: Date.now(), disks: [], roots: [], skipped: 0 });
  });
  app.use(express.static(process.env.RESOURCE_TEST_DIST || 'dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', socket => socket.send(JSON.stringify({ type: 'snapshot', codexStatus: 'ready', models: [], workspaces: [{ id: 'project', name: 'Project', path: '/tmp' }], defaultWorkspaceId: 'project', conversations: [], terminals: [{ id: 'terminal', isDefault: true, workspaceId: 'project', title: '终端', replay: '' }], approvals: [] })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await run(state);
    expect(errors).toEqual([]);
  } finally {
    state.metricsGate?.resolve(); state.sessionGate?.resolve(); state.storageGate?.resolve(); state.requestsGate?.resolve();
    await page.goto('about:blank');
    for (const socket of wss.clients) socket.terminate();
    wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

test('metrics warm every second before opening and cached values appear while reopen requests are delayed', async ({ page }) => {
  await withResourceServer(page, async state => {
    await waitForCount(state.metricsStarts, 4);
    expect(state.sessions).toBe(0);
    expectOneSecondCadence(state.metricsStarts.slice(0, 4));
    await resourceButton(page).click();
    await expect(resourceDialog(page).locator('.resource-big-number')).toContainText('12.5%');
    await expect.poll(() => state.sessions).toBe(1);
    await page.keyboard.press('Escape');
    await expect(resourceDialog(page)).toHaveCount(0);
    await expect.poll(() => state.closedSessions).toBe(1);

    state.metricsGate = deferred(); state.sessionGate = deferred();
    const before = state.metricsStarts.length;
    await waitForCount(state.metricsStarts, before + 1);
    await resourceButton(page).click();
    await expect(resourceDialog(page).locator('.resource-big-number')).toContainText('12.5%', { timeout: 1000 });
    await expect(resourceDialog(page).locator('.resource-loading')).toHaveCount(0);
    expect(state.activeMetrics).toBe(1);
    expect(state.maxActiveMetrics).toBe(1);
  });
});

test('slow metrics requests never overlap or clear the last displayed values', async ({ page }) => {
  await withResourceServer(page, async state => {
    await waitForCount(state.metricsStarts, 1);
    await resourceButton(page).click();
    await expect(resourceDialog(page).locator('.resource-big-number')).toContainText('12.5%');
    state.metricsGate = deferred();
    const before = state.metricsStarts.length;
    await waitForCount(state.metricsStarts, before + 1);
    await page.waitForTimeout(2200);
    expect(state.metricsStarts.length).toBe(before + 1);
    expect(state.maxActiveMetrics).toBe(1);
    await expect(resourceDialog(page).locator('.resource-big-number')).toContainText('12.5%');
    const gate = state.metricsGate; state.metricsGate = null; state.value = 36.7; gate.resolve();
    await expect(resourceDialog(page).locator('.resource-big-number')).toContainText('36.7%');
    await waitForCount(state.metricsStarts, before + 2);
    expect(state.maxActiveMetrics).toBe(1);
  });
});

test('metrics errors keep the previous sample and recover automatically', async ({ page }) => {
  await withResourceServer(page, async state => {
    await waitForCount(state.metricsStarts, 1);
    await resourceButton(page).click();
    await expect(resourceDialog(page).locator('.resource-big-number')).toContainText('12.5%');
    state.failMetrics = true;
    await expect(resourceDialog(page).getByRole('alert')).toBeVisible();
    await expect(resourceDialog(page).locator('.resource-big-number')).toContainText('12.5%');
    await expect(resourceDialog(page).locator('.resource-loading')).toHaveCount(0);
    state.failMetrics = false; state.value = 42.5;
    await expect(resourceDialog(page).locator('.resource-big-number')).toContainText('42.5%');
    await expect(resourceDialog(page).getByRole('alert')).toHaveCount(0);
  });
});

test('reopening storage keeps the previous result visible during a delayed refresh', async ({ page }) => {
  await withResourceServer(page, async state => {
    await resourceButton(page).click();
    await resourceDialog(page).getByRole('tab', { name: '存储', exact: true }).click();
    await expect(resourceDialog(page).locator('.resource-storage-heading>div>strong')).toHaveText('1.0 KB');
    await page.keyboard.press('Escape');
    state.storageGate = deferred();
    await resourceButton(page).click();
    await resourceDialog(page).getByRole('tab', { name: '存储', exact: true }).click();
    await waitForCount(state.storageStarts, 2);
    await expect(resourceDialog(page).locator('.resource-storage-heading>div>strong')).toHaveText('1.0 KB', { timeout: 1000 });
    await expect(resourceDialog(page).locator('.resource-loading')).toHaveCount(0);
    state.storageValue = 2048; state.storageGate.resolve();
    await expect(resourceDialog(page).locator('.resource-storage-heading>div>strong')).toHaveText('2.0 KB');
  });
});

test('network requests refresh every second while the network tab is open', async ({ page }) => {
  await withResourceServer(page, async state => {
    await resourceButton(page).click();
    await resourceDialog(page).getByRole('tab', { name: '网络', exact: true }).click();
    await waitForCount(state.requestStarts, 4);
    expectOneSecondCadence(state.requestStarts.slice(0, 4));
    await resourceDialog(page).getByRole('tab', { name: 'CPU', exact: true }).click();
    const before = state.requestStarts.length;
    await page.waitForTimeout(1200);
    expect(state.requestStarts.length).toBe(before);
  });
});

test('hiding the page aborts a stalled network refresh and showing it resumes updates', async ({ page }) => {
  await withResourceServer(page, async state => {
    await resourceButton(page).click();
    await resourceDialog(page).getByRole('tab', { name: '网络', exact: true }).click();
    await waitForCount(state.requestStarts, 1);
    state.requestsGate = deferred();
    const blocked = state.requestsGate;
    try {
      const before = state.requestStarts.length;
      await waitForCount(state.requestStarts, before + 1);
      await page.waitForTimeout(1200);
      expect(state.requestStarts.length).toBe(before + 1);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect.poll(() => state.abortedRequests).toBe(1);
      state.requestsGate = null;
      state.requestItems = [{ id: 'recovered', startedAt: Date.now(), pid: 42, process: 'node', method: 'GET', url: '/api/recovered', status: 200, durationMs: 10 }];
      const visibleAt = Date.now();
      await page.evaluate(() => {
        delete document.visibilityState; delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitForCount(state.requestStarts, before + 2);
      expect(state.requestStarts.at(-1) - visibleAt).toBeLessThan(850);
      await expect(resourceDialog(page).locator('.resource-network-table')).toContainText('/api/recovered');
      await expect(resourceDialog(page).getByRole('alert')).toHaveCount(0);
    } finally { blocked.resolve(); }
  });
});

test('hidden pages pause metrics and immediately refresh on visibility restoration', async ({ page }) => {
  await withResourceServer(page, async state => {
    await waitForCount(state.metricsStarts, 1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = state.metricsStarts.length;
    await page.waitForTimeout(2200);
    expect(state.metricsStarts.length).toBe(before);
    const visibleAt = Date.now();
    await page.evaluate(() => {
      delete document.visibilityState; delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForCount(state.metricsStarts, before + 1);
    expect(state.metricsStarts.at(-1) - visibleAt).toBeLessThan(850);
  });
});
