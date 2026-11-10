import { copyTerminalSelection } from './terminalClipboard.js';

// Codex keeps selections in its transcript, including text outside the terminal
// screen, and returns the selected text through OSC 52 when the user copies.
export function bindTerminalNativeCopy(terminal, { enabled, onSelection, onStatus }) {
  const element = terminal.element;
  const document = element.ownerDocument;
  let dragging = false, armedUntil = 0, disposed = false;
  const arm = () => { armedUntil = Date.now() + 5000; };
  function down(event) {
    if (!enabled() || !event.isTrusted || event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    dragging = true; arm(); onSelection('');
  }
  function move(event) { if (dragging && event.isTrusted) arm(); }
  function up(event) { if (dragging && event.button === 0) { dragging = false; arm(); } }
  function key(event) {
    if (!enabled() || !event.isTrusted || terminal.hasSelection()) return;
    if (event.key === 'Escape') { armedUntil = 0; onSelection(''); return; }
    if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') || event.key === 'Enter') arm();
  }
  function blur() { dragging = false; armedUntil = 0; }
  const osc = terminal.parser.registerOscHandler(52, data => {
    // Replay and copies initiated by another connected browser must not overwrite
    // this device's clipboard. Queries are never allowed to read the clipboard.
    if (disposed || !enabled() || (!dragging && Date.now() > armedUntil)) return true;
    const delimiter = data.indexOf(';');
    if (delimiter < 0) return true;
    const encoded = data.slice(delimiter + 1);
    if (!encoded || encoded === '?' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return true;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0))); }
    catch { return true; }
    if (!text) return true;
    onSelection(text);
    // Do not stall xterm's parser while a browser clipboard operation is pending.
    copyTerminalSelection({ getSelection: () => text }).then(copied => {
      if (!disposed) onStatus(copied ? '已复制' : '已选中文字，点击复制按钮');
    }).catch(() => { if (!disposed) onStatus('已选中文字，点击复制按钮'); });
    return true;
  });
  element.addEventListener('mousedown', down, true);
  element.addEventListener('keydown', key, true);
  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseup', up, true);
  window.addEventListener('blur', blur);
  return () => {
    disposed = true; osc.dispose();
    element.removeEventListener('mousedown', down, true);
    element.removeEventListener('keydown', key, true);
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('mouseup', up, true);
    window.removeEventListener('blur', blur);
  };
}
