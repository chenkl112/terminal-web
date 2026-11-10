export async function copyTerminalSelection(terminal) {
  const text = terminal?.getSelection();
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

// Use xterm's own forced selection gesture so wide characters, wrapped lines,
// double-click selection and dragging beyond the viewport keep native behavior.
export function bindTerminalDirectCopy(terminal, copy, { nativeSelection = () => false, hasNativeSelection = () => false } = {}) {
  const element = terminal.element;
  const isMac = /Mac/.test(navigator.platform);
  let forwarding = false;
  function mouseDown(event) {
    if (event.button === 2 && (terminal.hasSelection() || hasNativeSelection())) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (forwarding || nativeSelection() || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || !event.target.closest?.('.xterm-screen') || event.sourceCapabilities?.firesTouchEvents || terminal.modes.mouseTrackingMode === 'none') return;
    event.preventDefault(); event.stopImmediatePropagation();
    forwarding = true;
    try {
      event.target.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, composed: true, view: window, detail: event.detail,
        screenX: event.screenX, screenY: event.screenY, clientX: event.clientX, clientY: event.clientY,
        button: 0, buttons: event.buttons, shiftKey: !isMac, altKey: isMac,
      }));
    } finally { forwarding = false; }
  }
  function mouseUp(event) {
    if (event.button === 2 && (terminal.hasSelection() || hasNativeSelection())) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  function contextMenu(event) {
    if (!terminal.hasSelection() && !hasNativeSelection()) return;
    event.preventDefault(); event.stopImmediatePropagation(); copy();
  }
  element.addEventListener('mousedown', mouseDown, true);
  element.addEventListener('mouseup', mouseUp, true);
  element.addEventListener('contextmenu', contextMenu, true);
  return () => {
    element.removeEventListener('mousedown', mouseDown, true);
    element.removeEventListener('mouseup', mouseUp, true);
    element.removeEventListener('contextmenu', contextMenu, true);
  };
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
