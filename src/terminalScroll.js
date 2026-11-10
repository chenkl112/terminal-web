// A CLI that handles wheel events owns its history. Local xterm scrollback can
// be just a few replay/reflow lines, so its presence must not intercept that wheel.
export function bindTerminalScrolling(terminal, { isCodex = () => false } = {}) {
  const element = terminal.element;
  let remainder = 0, appRemainder = 0, touchRemainder = 0, touchY = null;
  const lineHeight = () => (element.querySelector('.xterm-screen')?.getBoundingClientRect().height || terminal.rows * 18) / terminal.rows;
  const hasHistory = () => terminal.buffer.active.type === 'normal' && terminal.buffer.active.baseY > 0;
  // X10 reports presses only; it does not support application wheel scrolling.
  const nativeWheel = () => ['vt200', 'drag', 'any'].includes(terminal.modes.mouseTrackingMode);
  const applicationWheel = () => nativeWheel() || isCodex();
  function reportCodexWheel(pixels) {
    if (appRemainder && Math.sign(appRemainder) !== Math.sign(pixels)) appRemainder = 0;
    appRemainder += pixels / lineHeight();
    const lines = Math.trunc(appRemainder);
    if (!lines) return;
    appRemainder -= lines;
    // Codex ignores transcript wheel events that hit its composer/footer. Target
    // the reply area even if the user's pointer is near the bottom of the screen.
    const col = Math.max(1, Math.floor(terminal.cols / 2));
    const row = Math.max(1, Math.floor(terminal.rows / 3));
    // Codex uses SGR, including when its setup is missing from capped replay.
    const sequence = `\x1b[<${lines < 0 ? 64 : 65};${col};${row}M`;
    terminal.input(sequence.repeat(Math.min(Math.abs(lines), 12)), true);
  }
  function scrollPixels(pixels) {
    if (remainder && Math.sign(remainder) !== Math.sign(pixels)) remainder = 0;
    remainder += pixels / lineHeight();
    const lines = Math.trunc(remainder);
    if (lines) { terminal.scrollLines(lines); remainder -= lines; }
  }
  function wheel(event) {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    const pixels = event.deltaY * (event.deltaMode === 1 ? lineHeight() : event.deltaMode === 2 ? lineHeight() * terminal.rows : 1);
    // Shift explicitly chooses cached terminal history, including at its limits.
    if (event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation(); appRemainder = 0;
      if (hasHistory()) scrollPixels(pixels);
      return;
    }
    if (applicationWheel()) {
      remainder = 0;
      terminal.scrollToBottom();
      if (!isCodex() && nativeWheel()) { appRemainder = 0; return; }
      event.preventDefault(); event.stopImmediatePropagation();
      reportCodexWheel(pixels);
      return;
    }
    appRemainder = 0;
    if (!hasHistory()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    scrollPixels(pixels);
  }
  function touchStart(event) {
    touchY = event.touches.length === 1 && event.target.closest('.xterm-screen') ? event.touches[0].clientY : null;
    remainder = 0; appRemainder = 0; touchRemainder = 0;
  }
  function touchMove(event) {
    if (touchY == null || event.touches.length !== 1) { touchY = null; return; }
    if (!hasHistory() && !applicationWheel()) return;
    const next = event.touches[0].clientY, pixels = touchY - next;
    touchY = next;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!pixels) return;
    if (applicationWheel()) {
      if (touchRemainder && Math.sign(touchRemainder) !== Math.sign(pixels)) touchRemainder = 0;
      touchRemainder += pixels / lineHeight();
      const lines = Math.trunc(touchRemainder);
      if (!lines) return;
      touchRemainder -= lines;
      // Native xterm chooses the configured mouse encoding. Raw SGR is only a
      // fallback for a known Codex whose setup was truncated from the replay.
      // Use whole lines so xterm's trackpad damping cannot swallow a reversed swipe.
      element.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: Math.max(-12, Math.min(12, lines)), deltaMode: 1,
        clientX: event.touches[0].clientX, clientY: next,
      }));
    } else scrollPixels(pixels);
  }
  const touchEnd = () => { touchY = null; appRemainder = 0; touchRemainder = 0; };
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
