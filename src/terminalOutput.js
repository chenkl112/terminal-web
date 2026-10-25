// Give xterm small queue entries so its parser can yield between batches.
// A single multi-megabyte write cannot yield until that entry is parsed.
export function writeTerminalOutput(terminal, text, complete) {
  const chunkSize = 16 * 1024;
  if (!text) { terminal.write('', complete); return; }
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + chunkSize, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    terminal.write(text.slice(offset, end), end === text.length ? complete : undefined);
    offset = end;
  }
}
