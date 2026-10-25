// Inline CLI applications can enable mouse reporting while still relying on
// terminal scrollback. Keep that history accessible instead of swallowing wheels.
export function bindTerminalScrolling(terminal, { isCodex = () => false } = {}) {
  const element = terminal.element;
  let remainder = 0, touchY = null;
  const lineHeight = () => (element.querySelector('.xterm-screen')?.getBoundingClientRect().height || terminal.rows * 18) / terminal.rows;
  const hasHistory = () => terminal.buffer.active.type === 'normal' && terminal.buffer.active.baseY > 0;
  // A capped replay can start after Codex enabled mouse reporting. Recover
  // wheels for that known application without turning them into shell keys.
  const recoverCodexWheel = () => isCodex() && terminal.modes.mouseTrackingMode === 'none';
  function reportWheel(pixels, clientX, clientY) {
    const rect = element.querySelector('.xterm-screen').getBoundingClientRect();
    const col = Math.max(1, Math.min(terminal.cols, Math.floor((clientX - rect.left) / (rect.width / terminal.cols)) + 1));
    const row = Math.max(1, Math.min(terminal.rows, Math.floor((clientY - rect.top) / (rect.height / terminal.rows)) + 1));
    terminal.input(`\x1b[<${pixels < 0 ? 64 : 65};${col};${row}M`, true);
  }
  function scrollPixels(pixels) {
    remainder += pixels / lineHeight();
    const lines = Math.trunc(remainder);
    if (lines) { terminal.scrollLines(lines); remainder -= lines; }
  }
  function wheel(event) {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    if (!hasHistory()) {
      if (!recoverCodexWheel()) return;
      event.preventDefault(); event.stopImmediatePropagation();
      reportWheel(event.deltaY, event.clientX, event.clientY); return;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    const pixels = event.deltaY * (event.deltaMode === 1 ? lineHeight() : event.deltaMode === 2 ? lineHeight() * terminal.rows : 1);
    scrollPixels(pixels);
  }
  function touchStart(event) {
    touchY = event.touches.length === 1 && event.target.closest('.xterm-screen') ? event.touches[0].clientY : null;
    remainder = 0;
  }
  function touchMove(event) {
    if (touchY == null || event.touches.length !== 1) { touchY = null; return; }
    if (!hasHistory() && !recoverCodexWheel()) return;
    const next = event.touches[0].clientY;
    event.preventDefault(); event.stopImmediatePropagation();
    if (hasHistory()) { scrollPixels(touchY - next); touchY = next; }
    else if (Math.abs(touchY - next) >= lineHeight()) {
      reportWheel(touchY - next, event.touches[0].clientX, next); touchY = next;
    }
  }
  const touchEnd = () => { touchY = null; };
  element.addEventListener('wheel', wheel, { capture: true, passive: false });
  element.addEventListener('touchstart', touchStart, { capture: true, passive: true });
  element.addEventListener('touchmove', touchMove, { capture: true, passive: false });
  element.addEventListener('touchend', touchEnd, true);
  element.addEventListener('touchcancel', touchEnd, true);
  return () => {
    element.removeEventListener('wheel', wheel, true);
    element.removeEventListener('touchstart', touchStart, true);
    element.removeEventListener('touchmove', touchMove, true);
    element.removeEventListener('touchend', touchEnd, true);
    element.removeEventListener('touchcancel', touchEnd, true);
  };
}
