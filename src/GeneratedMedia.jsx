import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Image, LoaderCircle, Maximize2 } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Modal } from './Sidebar.jsx';
import { conversationFileUrl, decodeFileReference, imageFileName, isLocalFileReference, nativeImageSource } from '../shared/media.js';
import './media.css';

function ImageViewer({ image, onClose }) {
  return <Modal title={image.name || '查看图片'} onClose={onClose} className="image-viewer-modal">
    <img src={image.src} alt={image.name || '生成的图片'} className="image-viewer-content" />
    <footer><a className="image-download" href={image.download || image.src} download target="_blank" rel="noreferrer"><Download size={15} />下载原图</a></footer>
  </Modal>;
}

export function MessageMarkdown({ text, conversation }) {
  const [preview, setPreview] = useState(null);
  const [downloadError, setDownloadError] = useState(null);
  useEffect(() => { setDownloadError(null); }, [text, conversation?.id]);
  async function download(event) {
    const link = event.target.closest?.('a[download]');
    if (!link || !link.getAttribute('href')?.startsWith('/api/conversations/')) return;
    event.preventDefault();
    const url = link.getAttribute('href');
    setDownloadError(null);
    try {
      // Let the browser stream large downloads; do not buffer the file in JS memory.
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录后下载'
        : response.status === 403 ? '无法读取此文件，或该文件未在当前对话中提供'
        : response.status === 404 ? '文件不存在或已被移动'
        : `下载服务暂时不可用（${response.status}）`);
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = link.getAttribute('download') || ''; document.body.append(anchor);
      anchor.click(); anchor.remove();
    } catch (error) { setDownloadError(error instanceof TypeError ? '无法连接下载服务，请检查网络后重试' : error.message); }
  }
  const { html, files } = useMemo(() => {
    const files = new Map();
    const template = document.createElement('template'); template.innerHTML = marked.parse(text || '', { breaks: true, gfm: true });
    for (const link of template.content.querySelectorAll('a[href]')) {
      const value = link.getAttribute('href');
      if (conversation?.id && isLocalFileReference(value)) {
        const url = conversationFileUrl(conversation.id, value, false, true);
        link.setAttribute('href', url); link.setAttribute('download', '');
        const name = imageFileName(value);
        const displayPath = decodeFileReference(value);
        if (!/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(name) && !files.has(value)) files.set(value, { path: displayPath, name, url });
      }
      if (link.getAttribute('target') === '_blank') link.setAttribute('rel', 'noopener noreferrer');
    }
    const originals = new Map();
    for (const img of template.content.querySelectorAll('img[src]')) {
      const original = img.getAttribute('src');
      if (conversation?.id && isLocalFileReference(original)) {
        const src = conversationFileUrl(conversation.id, original, true);
        originals.set(src, original); img.setAttribute('src', src);
      }
    }
    template.innerHTML = DOMPurify.sanitize(template.innerHTML, { ADD_ATTR: ['target'], ALLOW_DATA_ATTR: false, FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'] });
    for (const img of template.content.querySelectorAll('img[src]')) {
      const original = originals.get(img.getAttribute('src')) || img.getAttribute('src');
      const local = conversation?.id && isLocalFileReference(original);
      const src = local ? conversationFileUrl(conversation.id, original, true) : original;
      const download = local ? conversationFileUrl(conversation.id, original, false, true) : original;
      img.setAttribute('src', src); img.setAttribute('loading', 'lazy'); img.setAttribute('decoding', 'async');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'generated-image-trigger';
      button.dataset.previewSrc = src; button.dataset.previewDownload = download;
      button.dataset.previewName = img.getAttribute('alt') || imageFileName(original);
      button.setAttribute('aria-label', `查看大图：${button.dataset.previewName}`);
      if (img.parentElement?.tagName === 'A') img.parentElement.replaceWith(button); else img.replaceWith(button);
      button.appendChild(img);
    }
    return { html: template.innerHTML, files: [...files.values()] };
  }, [text, conversation?.id]);
  function click(event) {
    if (event.target.closest?.('a[download]')) { download(event); return; }
    const button = event.target.closest?.('[data-preview-src]');
    if (!button) return;
    event.preventDefault();
    const img = button.querySelector('img');
    if (button.dataset.failed) {
      delete button.dataset.failed; button.querySelector('.image-load-error')?.remove();
      img.style.display = ''; img.src = button.dataset.previewSrc + (button.dataset.previewSrc.startsWith('/api/') ? `&retry=${Date.now()}` : '');
      return;
    }
    setPreview({ src: button.dataset.previewSrc, download: button.dataset.previewDownload, name: button.dataset.previewName });
  }
  function failed(event) {
    const img = event.target; const button = img.closest?.('[data-preview-src]');
    if (!button || button.dataset.failed) return;
    button.dataset.failed = '1'; img.style.display = 'none';
    const label = document.createElement('span'); label.className = 'image-load-error'; label.textContent = '图片暂时无法加载，点击重试'; button.appendChild(label);
  }
  return <><div className="markdown" onClick={click} onErrorCapture={failed} dangerouslySetInnerHTML={{ __html: html }} />{files.length > 0 && <div className="generated-files" role="list" aria-label="可下载文件" onClick={download}>{files.map(file => <div key={file.path} className="generated-file" role="listitem"><FileText size={23} /><div><strong>{file.name}</strong><span title={file.path}>{file.path}</span></div><a href={file.url} download={file.name} aria-label={`下载文件：${file.name}`} title="保存到此设备"><Download size={16} /><span>下载</span></a></div>)}</div>}{downloadError && <div className="turn-error" role="alert">下载失败：{downloadError}</div>}{preview && <ImageViewer image={preview} onClose={() => setPreview(null)} />}</>;
}

export function NativeImage({ item, conversation }) {
  const image = useMemo(() => nativeImageSource(item, conversation.id), [item.path, item.savedPath, item.result, conversation.id]);
  const [preview, setPreview] = useState(false), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); setAttempt(0); }, [image?.src]);
  if (!image) {
    if (item.failure || item.status === 'failed') return <div className="turn-error">图片生成失败：{item.failure?.message || '请重试'}</div>;
    return <div className="generated-image-pending"><LoaderCircle size={17} className="spin" />正在生成图片…</div>;
  }
  return <><figure className="generated-image-card"><button className="generated-image-trigger" onClick={() => { if (failed) { setFailed(false); setAttempt(value => value + 1); } else setPreview(true); }} aria-label={`查看大图：${image.name}`}>
    {failed ? <span className="image-load-error"><Image size={20} />图片暂时无法加载，点击重试</span> : <img src={image.src + (attempt && image.src.startsWith('/api/') ? `&retry=${attempt}` : '')} alt={image.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </button><figcaption><span>{image.name}</span><button aria-label="放大图片" onClick={() => setPreview(true)}><Maximize2 size={14} /></button><a href={image.download} download target="_blank" rel="noreferrer" aria-label="下载原图"><Download size={14} /></a></figcaption></figure>{preview && <ImageViewer image={image} onClose={() => setPreview(false)} />}</>;
}
