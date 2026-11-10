import React, { useEffect, useRef, useState } from 'react';
import { Download, FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import { Modal } from './Sidebar.jsx';
import { inspectTerminalAsset, terminalAssetUrl } from './terminalDownloads.js';
import './terminalDownloads.css';

const serviceMessage = '终端下载服务尚未启用，需要重启后端服务后重试';
function responseFailure(response, data) {
  return new Error(response.status === 404 && data.error === '接口不存在' ? serviceMessage : data.error || '无法下载此文件');
}

export default function TerminalDownloads({ terminal, initialPath = '', paths = [], onClose }) {
  const [value, setValue] = useState(initialPath);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [available, setAvailable] = useState([]), [loading, setLoading] = useState(true), [listError, setListError] = useState('');
  const [refresh, setRefresh] = useState(0), [unavailable, setUnavailable] = useState(false);
  const request = useRef(null);
  const pathsKey = JSON.stringify(paths);
  const base = `/api/terminals/${encodeURIComponent(terminal.id)}/files`;
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setListError(''); setAvailable([]);
    const candidates = JSON.parse(pathsKey), origin = window.location.origin;
    const assets = candidates.filter(reference => terminalAssetUrl(reference, origin));
    const local = candidates.filter(reference => !terminalAssetUrl(reference, origin));
    async function check() {
      const localFiles = local.length ? fetch(`${base}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: local }), signal: controller.signal }).then(async response => {
        const data = await response.json(); if (!response.ok) throw responseFailure(response, data); return data.files || [];
      }) : Promise.resolve([]);
      const assetFiles = (async () => {
        const files = [];
        for (let index = 0; index < assets.length; index += 4) {
          const checked = await Promise.all(assets.slice(index, index + 4).map(async reference => {
            try { return { ...await inspectTerminalAsset(reference, { origin, signal: controller.signal }), reference }; }
            catch (failure) { if (controller.signal.aborted) throw failure; return null; }
          }));
          files.push(...checked.filter(Boolean));
        }
        return files;
      })();
      const results = await Promise.allSettled([localFiles, assetFiles]);
      if (controller.signal.aborted) return;
      const files = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      const order = new Map(candidates.map((reference, index) => [reference, index]));
      files.sort((a, b) => (order.get(a.reference) ?? 0) - (order.get(b.reference) ?? 0));
      setAvailable(files.filter((file, index) => files.findIndex(other => other.path === file.path) === index));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      setUnavailable(false);
    }
    check().catch(failure => {
        if (controller.signal.aborted) return;
        setListError(failure instanceof TypeError ? '无法连接下载服务，请检查网络后重试' : failure.message);
        setUnavailable(failure.message === serviceMessage);
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, pathsKey, refresh]);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  async function download(filePath) {
    if (!filePath.trim() || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setStatus(''); setValue(filePath);
    try {
      let file, url;
      const asset = terminalAssetUrl(filePath, window.location.origin);
      if (asset) {
        file = await inspectTerminalAsset(asset, { origin: window.location.origin, signal: controller.signal }); url = file.reference;
      } else {
        const params = new URLSearchParams({ path: filePath, info: '1' });
        const response = await fetch(`${base}?${params}`, { signal: controller.signal }); file = await response.json();
        if (!response.ok) throw responseFailure(response, file);
        params.delete('info'); url = `${base}?${params}`;
      }
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setStatus(`已开始下载 ${file.name}，进度可在浏览器下载列表查看`);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof TypeError ? '无法连接下载服务，请检查网络后重试' : failure.message);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <Modal title="终端下载" onClose={onClose} className="terminal-download-dialog">
    <p className="terminal-download-caption">把终端生成的文件保存到当前设备。</p>
    <form onSubmit={event => { event.preventDefault(); download(value); }}>
      <label htmlFor={`terminal-download-${terminal.id}`}>文件路径</label>
      <div className="terminal-download-input"><input id={`terminal-download-${terminal.id}`} value={value} placeholder="粘贴文件路径或网页资源链接" autoComplete="off" spellCheck={false} onChange={event => { setValue(event.target.value); setError(''); setStatus(''); }} /><button type="submit" className="primary" disabled={busy || unavailable && !terminalAssetUrl(value, window.location.origin) || !value.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}下载</button></div>
      <p className="terminal-download-base" title={terminal.cwd}>相对路径起点：{terminal.cwd}</p>
    </form>
    {error && <p className="directory-error" role="alert">{error}</p>}
    {status && <p className="terminal-download-status" role="status">{status}</p>}
    <h3>最近输出中的文件</h3>
    {loading ? <p className="terminal-download-empty" role="status"><LoaderCircle size={14} className="spin" />正在检查可下载文件…</p>
      : <>{listError && <div className="terminal-download-list-error"><p className="directory-error" role="alert">{listError}</p><button type="button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />重新检查</button></div>}
        {available.length ? <div className="terminal-download-list" role="list" aria-label="终端文件">{available.map(file => <div role="listitem" key={file.path}><FileText size={19} /><div><strong>{file.name}</strong><small title={file.path}>{file.path}</small></div><button type="button" disabled={busy} aria-label={`下载文件：${file.name}`} title={file.path} onClick={() => download(file.reference)}><Download size={16} /><span>下载</span></button></div>)}</div>
          : <p className="terminal-download-empty">最近输出中没有可下载的文件。可在上方粘贴文件路径，或选中终端中的路径后点击“下载”。</p>}
      </>}
  </Modal>;
}
