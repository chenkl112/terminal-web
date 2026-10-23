export async function copyTerminalSelection(terminal) {
  const text = terminal.getSelection();
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* LAN pages can require the legacy clipboard path. */ }
  }
  const previous = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text; field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
  document.body.appendChild(field); field.select();
  try { return document.execCommand('copy'); }
  finally { field.remove(); previous?.focus({ preventScroll: true }); }
}

export function bindTerminalCopyKeys(terminal, copy) {
  terminal.attachCustomKeyEventHandler(event => {
    if (event.altKey || event.key.toLowerCase() !== 'c' || !(event.ctrlKey || event.metaKey)) return true;
    if (!terminal.hasSelection() && !(event.ctrlKey && event.shiftKey)) return true;
    event.preventDefault(); event.stopPropagation();
    if (event.type === 'keydown' && !event.repeat) copy();
    return false;
  });
}
