// One sampler per authenticated page; opening a dialog only subscribes to it.
export const RESOURCE_REFRESH_MS = 1000;
export const resourceCache = { storage: null };
let snapshot = { metrics: null, error: '' };
const listeners = new Set();
let diagnosticSession = null;

export const getResourceMetrics = () => snapshot;
export function subscribeResourceMetrics(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publish(next) {
  snapshot = next;
  for (const listener of listeners) listener();
}
export function attachDiagnosticSession(id) {
  diagnosticSession = id;
  return () => { if (diagnosticSession === id) diagnosticSession = null; };
}

export function startResourceMonitoring() {
  let stopped = false, timer, controller, pending = false;
  async function poll() {
    if (stopped || pending || document.visibilityState === 'hidden') return;
    pending = true;
    const current = new AbortController();
    controller = current;
    // A stalled connection must not prevent all later samples.
    const timeout = setTimeout(() => current.abort(), 5000);
    try {
      const query = diagnosticSession ? `?session=${encodeURIComponent(diagnosticSession)}` : '';
      const response = await fetch(`/api/resources/metrics${query}`, { signal: current.signal });
      if (!response.ok) throw new Error('资源信息暂时无法读取');
      const metrics = await response.json();
      if (!stopped && !current.signal.aborted) publish({ metrics, error: '' });
    } catch {
      if (!stopped && document.visibilityState !== 'hidden') publish({ ...snapshot, error: '资源信息暂时无法读取，正在重试…' });
    } finally {
      clearTimeout(timeout);
      pending = false;
      if (!stopped && document.visibilityState !== 'hidden') {
        // The server caches from sample completion for 1 s. Waiting from the
        // response avoids getting the same sample on every other request.
        timer = setTimeout(poll, current.signal.aborted ? 0 : RESOURCE_REFRESH_MS);
      }
    }
  }
  function visibilityChanged() {
    clearTimeout(timer);
    if (document.visibilityState === 'hidden') controller?.abort();
    else poll();
  }
  document.addEventListener('visibilitychange', visibilityChanged);
  poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    document.removeEventListener('visibilitychange', visibilityChanged);
    diagnosticSession = null;
    resourceCache.storage = null;
    publish({ metrics: null, error: '' });
  };
}
