const escape = '\x1b';
const cursorKeys = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
const numberedKeys = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const shiftedSymbols = { '/': '?', '\\': '|', '[': '{', ']': '}', '-': '_', '=': '+', '`': '~', ';': ':', "'": '"', ',': '<', '.': '>' };

export function terminalKeySequence(key, { ctrl = false, alt = false, shift = false } = {}, applicationCursor = false) {
  const modifier = 1 + Number(shift) + Number(alt) * 2 + Number(ctrl) * 4;
  if (cursorKeys[key]) return modifier > 1 ? `${escape}[1;${modifier}${cursorKeys[key]}` : `${escape}${applicationCursor ? 'O' : '['}${cursorKeys[key]}`;
  if (numberedKeys[key]) return `${escape}[${numberedKeys[key]}${modifier > 1 ? `;${modifier}` : ''}~`;
  if (/^F[1-4]$/.test(key)) { const final = 'PQRS'[Number(key.slice(1)) - 1]; return modifier > 1 ? `${escape}[1;${modifier}${final}` : `${escape}O${final}`; }
  if (key === 'Tab') return shift ? `${escape}[Z` : '\t';
  if (key === 'Enter') return shift ? `${escape}[13;${modifier}u` : `${alt ? escape : ''}${ctrl ? '\n' : '\r'}`;
  if (key === 'Escape') return `${alt ? escape : ''}${escape}`;
  if (key === 'Backspace') return `${alt ? escape : ''}${ctrl ? '\b' : '\x7f'}`;
  if (key === 'Space') key = ' ';
  if (key.length !== 1) return '';
  let text = shift ? shiftedSymbols[key] || key.toUpperCase() : key;
  if (ctrl) {
    const code = text.toUpperCase().charCodeAt(0);
    if (text === ' ') text = '\0';
    else if (text === '?') text = '\x7f';
    else if (code >= 64 && code <= 95) text = String.fromCharCode(code & 31);
    else return '';
  }
  return `${alt ? escape : ''}${text}`;
}

export function terminalScreenText(terminal) {
  const buffer = terminal.buffer.active;
  let text = '';
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) break;
    if (row && !line.isWrapped) text += '\n';
    text += line.translateToString(!buffer.getLine(buffer.viewportY + row + 1)?.isWrapped);
  }
  return text.replace(/\n+$/, '');
}
