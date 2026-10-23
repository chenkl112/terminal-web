export function isLocalFileReference(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')) return false;
  if (/^(?:sandbox:|file:)/i.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('#') || value.startsWith('?')) return false;
  if (/^\/(?:api|assets)(?:\/|$)/.test(value)) return false;
  return value.startsWith('/') || /(?:^|\/)\.?[^/]*\.[a-z0-9]{1,12}(?:[?#].*)?$/i.test(value);
}

export function conversationFileUrl(id, reference, image = false, download = false) {
  const params = new URLSearchParams({ path: reference });
  if (image) params.set('image', '1');
  if (download) params.set('download', '1');
  return `/api/conversations/${encodeURIComponent(id)}/files?${params}`;
}

export function imageFileName(value) {
  try { return decodeURIComponent(value.split(/[?#]/)[0].split('/').pop()) || '图片'; }
  catch { return '图片'; }
}

export function nativeImageSource(item, id) {
  const value = item.savedPath || item.path || item.result;
  if (typeof value !== 'string' || !value) return null;
  if ((item.savedPath || item.path) && isLocalFileReference(value)) return { src: conversationFileUrl(id, value, true), download: conversationFileUrl(id, value, false, true), name: imageFileName(value) };
  if (/^(?:https?:\/\/|data:image\/(?:png|jpeg|webp|gif|avif|bmp);base64,)/i.test(value)) return { src: value, download: value, name: '生成的图片' };
  if (value.length > 128 && /^[a-z0-9+/=\r\n]+$/i.test(value)) {
    const mime = value.startsWith('/9j/') ? 'jpeg' : value.startsWith('UklGR') ? 'webp' : value.startsWith('R0lGOD') ? 'gif' : 'png';
    const src = `data:image/${mime};base64,${value.replace(/[\r\n]/g, '')}`;
    return { src, download: src, name: `生成的图片.${mime === 'jpeg' ? 'jpg' : mime}` };
  }
  if (isLocalFileReference(value)) return { src: conversationFileUrl(id, value, true), download: conversationFileUrl(id, value, false, true), name: imageFileName(value) };
  return null;
}
