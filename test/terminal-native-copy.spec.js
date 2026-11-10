import { test, expect } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const visibleText = 'Visible Codex reply 中文  keep   spaces';
const longSelection = Array.from({ length: 180 }, (_, index) =>
  `${String(index + 1).padStart(3, '0')} 已输出的长篇文字：保留中文、换行和空格 🚀  keep   spaces`,
).join('\n');
const osc52 = text => `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;

// Model the CLI's native selection protocol through the public PTY transport.
// The copied text exceeds both the visible screen and a terminal-output chunk.
async function withNativeTerminal(page, options, run) {
  const input = [];
  let selecting = false, dragged = false, selected = false, marker = 0;
  const terminal = { id: 'native', workspaceId: 'project', title: 'Codex 终端', isDefault: true, cols: 100, rows: 30,
    replay: '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'
      + '\x1b]7501;state=idle:app=codex\x07' + visibleText
      + (options.replayClipboard ? osc52('stale replay clipboard') : '') };
  if (options.truncatedReplay) {
    const tail = `\x1b[2J\x1b[H${options.missingAppMarker ? '' : '\x1b]7501;state=idle:app=codex\x07'}${visibleText}`;
    const redraw = '\x1b[H\x1b[2Kold frame\r';
    const length = 2 * 1024 * 1024 - tail.length;
    terminal.replay = redraw.repeat(Math.ceil(length / redraw.length)).slice(-length) + tail;
  }
  const other = { id: 'other', workspaceId: 'project', title: '另一个终端', cols: 100, rows: 30, replay: 'OTHER SHELL' };
  const snapshot = { type: 'snapshot', codexStatus: 'ready', models: [],
    workspaces: [{ id: 'project', name: 'Project', path: '/tmp' }], defaultWorkspaceId: 'project',
    conversations: [], terminals: [terminal, other], approvals: [] };
  const app = express();
  app.get('/api/auth', (_, res) => res.json({ authenticated: true }));
  app.use(express.static(process.env.NATIVE_COPY_TEST_DIST || 'dist'));
  const server = createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
  function output(data, id = terminal.id) {
    for (const socket of wss.clients) if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'terminal/data', id, data }));
    }
  }
  function emitSelection() {
    const sequence = osc52(longSelection);
    // Split inside the base64 payload to exercise streaming terminal parsing.
    output(sequence.slice(0, 31)); output(sequence.slice(31));
  }
  wss.on('connection', socket => {
    socket.send(JSON.stringify(snapshot));
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type !== 'terminal/input') return;
      input.push(message);
      if (message.id !== terminal.id) return;
      for (const match of message.data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
        const button = Number(match[1]);
        if (button === 0 && match[4] === 'M') { selecting = true; dragged = false; selected = false; }
        if (selecting && (button === 32 || button === 64 || button === 65)) dragged = true;
        if (button === 0 && match[4] === 'm') {
          if (selecting && dragged) {
            selected = true;
            if (options.autoCopy !== false) emitSelection();
          }
          selecting = false;
        }
      }
      if (message.data === '\x03' && selected && options.autoCopy !== false) emitSelection();
    });
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  try {
    // Set a real clipboard sentinel before any snapshot has been received.
    await page.goto(`${origin}/api/auth`);
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await page.addInitScript(mode => {
      window.__readClipboard = navigator.clipboard.readText.bind(navigator.clipboard);
      window.__writeClipboard = navigator.clipboard.writeText.bind(navigator.clipboard);
      if (mode === 'unavailable') Object.defineProperty(navigator, 'clipboard', { value: undefined });
      if (mode === 'denied') Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('clipboard permission denied')) },
      });
    }, options.clipboard || 'native');
    await page.goto(origin);
    await page.getByRole('tab', { name: terminal.title, exact: true }).click();
    const view = page.getByRole('region', { name: terminal.title, exact: true, includeHidden: true });
    await expect(view).toHaveAttribute('aria-busy', 'false');
    await expect(view.locator('.xterm-rows')).toContainText(visibleText);
    await run({ input, view, output, async observedOutput(data) {
      const text = `OUTPUT PROCESSED ${++marker}`;
      output(`${data}\x1b[4;1H\x1b[2K${text}`);
      await expect(view.locator('.xterm-rows')).toContainText(text);
    } });
  } finally {
    await page.goto('about:blank');
    for (const socket of wss.clients) socket.terminate();
    wss.close(); server.closeAllConnections(); server.close();
  }
}

async function nativeDrag(page, view, { wheel = false } = {}) {
  const screen = await view.locator('.xterm-screen').boundingBox();
  await page.mouse.move(screen.x + 12, screen.y + 10);
  await page.mouse.down();
  await page.mouse.move(screen.x + screen.width / 2, screen.y + Math.min(180, screen.height / 2), { steps: 12 });
  if (wheel) await page.mouse.wheel(0, 240);
  await page.mouse.up();
}

for (const clipboard of ['native', 'unavailable', 'denied']) {
  test(`Codex native drag copies a whole long Unicode selection (${clipboard} clipboard)`, async ({ page }) => {
    await withNativeTerminal(page, { clipboard }, async ({ input, view }) => {
      await nativeDrag(page, view, { wheel: true });
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(longSelection);
      expect(input.map(message => message.data).join('')).toMatch(/\x1b\[<0;\d+;\d+M/);
      expect(input.map(message => message.data).join('')).toMatch(/\x1b\[<32;\d+;\d+M/);
      expect(input.map(message => message.data).join('')).toMatch(/\x1b\[<65;\d+;\d+M/);
      expect(input.map(message => message.data).join('')).toMatch(/\x1b\[<0;\d+;\d+m/);
      const copy = view.getByRole('button', { name: '复制选中内容', exact: true });
      await expect(copy).toBeEnabled();
      await expect(view.locator('.terminal-copy-tools [role=status]')).toHaveText('已复制');

      await page.evaluate(() => window.__writeClipboard('sentinel'));
      await copy.click();
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(longSelection);

      await page.evaluate(() => window.__writeClipboard('sentinel'));
      const before = input.length;
      await page.keyboard.press('Control+c');
      await expect.poll(() => input.slice(before).some(message => message.data === '\x03')).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(longSelection);
    });
  });
}

test('a blocked automatic clipboard write preserves the selection for an explicit copy retry', async ({ page }) => {
  await withNativeTerminal(page, { clipboard: 'denied' }, async ({ view }) => {
    await page.evaluate(() => {
      window.__execCommand = document.execCommand.bind(document);
      document.execCommand = (command, ...args) => command === 'copy' ? false : window.__execCommand(command, ...args);
    });
    await nativeDrag(page, view);
    const copy = view.getByRole('button', { name: '复制选中内容', exact: true });
    await expect(copy).toBeEnabled();
    await expect(view.locator('.terminal-copy-tools [role=status]')).toContainText('点击复制');
    expect(await page.evaluate(() => window.__readClipboard())).toBe('sentinel');
    await page.evaluate(() => { document.execCommand = window.__execCommand; });
    await copy.click();
    await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(longSelection);
    await expect(view.locator('.terminal-copy-tools [role=status]')).toHaveText('已复制');
  });
});

test('Shift drag still selects and copies the visible xterm text locally', async ({ page }) => {
  await withNativeTerminal(page, {}, async ({ input, view }) => {
    await nativeDrag(page, view);
    await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(longSelection);
    await page.evaluate(() => window.__writeClipboard('sentinel'));
    const row = await view.locator('.xterm-rows > div').first().boundingBox();
    await page.keyboard.down('Shift');
    const before = input.length;
    await page.mouse.move(row.x + 1, row.y + row.height / 2);
    await page.mouse.down();
    await page.mouse.move(row.x + row.width - 2, row.y + row.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(visibleText);
    expect(input.slice(before).filter(message => message.data === '\x03' || /\x1b\[<0;/.test(message.data))).toEqual([]);
  });
});

for (const missingAppMarker of [false, true]) test(`Codex native selection survives capped replay (app marker ${missingAppMarker ? 'missing' : 'retained'})`, async ({ page }) => {
  await withNativeTerminal(page, { truncatedReplay: true, missingAppMarker }, async ({ input, view }) => {
    for (const refresh of [false, true]) {
      if (refresh) {
        await page.reload();
        await expect(view).toHaveAttribute('aria-busy', 'false');
        await expect(view.locator('.xterm-rows')).toContainText(visibleText);
      }
      await page.evaluate(() => window.__writeClipboard('sentinel'));
      const before = input.length;
      await nativeDrag(page, view);
      await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(longSelection);
      expect(input.slice(before).map(message => message.data).join('')).toMatch(/\x1b\[<0;\d+;\d+M/);
      expect(input.slice(before).map(message => message.data).join('')).toMatch(/\x1b\[<0;\d+;\d+m/);
    }
  });
});

test('snapshot replay and unsolicited live OSC52 cannot overwrite the clipboard', async ({ page }) => {
  await withNativeTerminal(page, { replayClipboard: true }, async ({ view, observedOutput }) => {
    expect(await page.evaluate(() => window.__readClipboard())).toBe('sentinel');
    await expect(view.getByRole('button', { name: '复制选中内容', exact: true })).toBeDisabled();
    await observedOutput(osc52('remote browser selection'));
    expect(await page.evaluate(() => window.__readClipboard())).toBe('sentinel');
    await expect(view.getByRole('button', { name: '复制选中内容', exact: true })).toBeDisabled();

    await nativeDrag(page, view);
    await expect.poll(() => page.evaluate(() => window.__readClipboard())).toBe(longSelection);
    await page.evaluate(() => window.__writeClipboard('sentinel'));
    await page.reload();
    await expect(view).toHaveAttribute('aria-busy', 'false');
    await expect(view.locator('.xterm-rows')).toContainText(visibleText);
    expect(await page.evaluate(() => window.__readClipboard())).toBe('sentinel');
    await expect(view.getByRole('button', { name: '复制选中内容', exact: true })).toBeDisabled();
  });
});

test('OSC52 clipboard queries are ignored even after a local selection gesture', async ({ page }) => {
  await withNativeTerminal(page, { autoCopy: false }, async ({ input, view, observedOutput }) => {
    await nativeDrag(page, view);
    const before = input.length;
    await observedOutput('\x1b]52;c;?\x07');
    expect(await page.evaluate(() => window.__readClipboard())).toBe('sentinel');
    expect(input.slice(before).some(message => message.data.includes('\x1b]52;'))).toBe(false);
  });
});

test('an inactive terminal cannot update the clipboard after selecting in that terminal', async ({ page }) => {
  await withNativeTerminal(page, { autoCopy: false }, async ({ view, output }) => {
    await nativeDrag(page, view);
    await page.getByRole('tab', { name: '另一个终端', exact: true }).click();
    await expect(page.getByRole('region', { name: '另一个终端', exact: true })).toHaveAttribute('aria-busy', 'false');
    output(osc52(longSelection));
    output('\r\nINACTIVE COPY PROCESSED', 'other');
    await expect(page.getByRole('region', { name: '另一个终端', exact: true }).locator('.xterm-rows')).toContainText('INACTIVE COPY PROCESSED');
    expect(await page.evaluate(() => window.__readClipboard())).toBe('sentinel');
  });
});
