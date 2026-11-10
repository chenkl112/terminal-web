import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTerminalScrolling } from '../src/terminalScroll.js';

function fixture(t, { codex = false, mode = 'none', baseY = 3 } = {}) {
  const element = new EventTarget(), input = [], scrolls = [];
  element.querySelector = () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) });
  const terminal = { element, rows: 20, cols: 80, modes: { mouseTrackingMode: mode },
    buffer: { active: { type: 'normal', baseY, viewportY: baseY } },
    scrollToBottom() { this.buffer.active.viewportY = this.buffer.active.baseY; },
    scrollLines(lines) { scrolls.push(lines); this.buffer.active.viewportY = Math.max(0, Math.min(baseY, this.buffer.active.viewportY + lines)); },
    input(data) { input.push(data); } };
  t.after(bindTerminalScrolling(terminal, { isCodex: () => codex }));
  function wheel(deltaY, options = {}) {
    const event = new Event('wheel', { cancelable: true });
    Object.assign(event, { deltaY, deltaMode: 0, clientX: 25, clientY: 25, ctrlKey: false, metaKey: false, shiftKey: false }, options);
    element.dispatchEvent(event); return event;
  }
  return { terminal, input, scrolls, wheel };
}

test('short Codex replay scrollback cannot consume ordinary wheels; trackpad pixels accumulate and reverse cleanly', t => {
  const f = fixture(t, { codex: true });
  for (let n = 0; n < 4; n++) f.wheel(-4);
  assert.equal(f.input.length, 0);
  f.wheel(-4); assert.equal(f.input.length, 1); assert.match(f.input[0], /^\x1b\[<64;/);
  f.wheel(-8); f.wheel(12); assert.equal(f.input.length, 1);
  f.wheel(8); assert.equal(f.input.length, 2); assert.match(f.input[1], /^\x1b\[<65;/);
  f.wheel(-100000); assert.equal([...f.input[2].matchAll(/\x1b\[<64;/g)].length, 12);
  assert.deepEqual(f.scrolls, []);
});

test('Codex wheel over the composer targets reply content with or without startup mouse mode', t => {
  for (const mode of ['none', 'any']) {
    const f = fixture(t, { codex: true, mode });
    const event = f.wheel(-40, { clientX: 799, clientY: 399 });
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.input[0], '\x1b[<64;40;6M'.repeat(2));
    assert.deepEqual(f.scrolls, []);
  }
});

test('line/page wheel units and Shift history routing work without forwarding history scrolls to the CLI', t => {
  const f = fixture(t, { codex: true });
  f.wheel(-2, { deltaMode: 1 }); assert.equal([...f.input[0].matchAll(/\x1b\[<64;/g)].length, 2);
  f.wheel(1, { deltaMode: 2 }); assert.equal([...f.input[1].matchAll(/\x1b\[<65;/g)].length, 12);
  f.wheel(-400, { shiftKey: true }); assert.equal(f.terminal.buffer.active.viewportY, 0);
  f.wheel(-400, { shiftKey: true }); assert.equal(f.input.length, 2);
  f.wheel(-20); assert.equal(f.input.length, 3); assert.equal(f.terminal.buffer.active.viewportY, 3);
});

test('native application wheels pass through while shell and X10 scrollback stay local at the top', t => {
  for (const mode of ['vt200', 'drag', 'any']) {
    const f = fixture(t, { mode }); f.terminal.buffer.active.viewportY = 0;
    assert.equal(f.wheel(-120).defaultPrevented, false); assert.equal(f.terminal.buffer.active.viewportY, 3);
    assert.deepEqual(f.input, []); assert.deepEqual(f.scrolls, []);
  }
  for (const mode of ['none', 'x10']) {
    const f = fixture(t, { mode });
    f.wheel(-400); f.wheel(-400); assert.equal(f.terminal.buffer.active.viewportY, 0);
    assert.deepEqual(f.input, []);
  }
});

test('zoom shortcuts and horizontal wheels do not become CLI input', t => {
  const f = fixture(t, { codex: true });
  for (const options of [{ ctrlKey: true }, { metaKey: true }]) assert.equal(f.wheel(-300, options).defaultPrevented, false);
  assert.equal(f.wheel(0).defaultPrevented, false); assert.deepEqual(f.input, []);
});
