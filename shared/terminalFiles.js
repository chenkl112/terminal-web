export function terminalDraftKey(terminal) {
  return terminal && `terminal:${terminal.isDefault ? `workspace:${terminal.workspaceId}` : terminal.id}`;
}

export function terminalFilePaths(files) {
  const paths = files.map(file => file.server?.path).filter(path => typeof path === 'string' && path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(path));
  return paths.length ? ` ${paths.map(path => `'${path.replace(/'/g, "'\"'\"'")}'`).join(' ')} ` : '';
}

export function* terminalInputChunks(text) {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 16384, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    yield text.slice(start, end); start = end;
  }
}
