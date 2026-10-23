import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalKeySequence as key, terminalScreenText } from '../shared/terminalKeys.js';

test('virtual terminal keys encode control combinations, cursor mode and function keys', () => {
  assert.equal(key('C', { ctrl: true }), '\x03');
  assert.equal(key('D', { ctrl: true }), '\x04');
  assert.equal(key('Z', { ctrl: true }), '\x1a');
  assert.equal(key('Space', { ctrl: true }), '\0');
  assert.equal(key('Tab', { shift: true }), '\x1b[Z');
  assert.equal(key('ArrowUp'), '\x1b[A');
  assert.equal(key('ArrowUp', {}, true), '\x1bOA');
  assert.equal(key('ArrowLeft', { ctrl: true, shift: true }, true), '\x1b[1;6D');
  assert.equal(key('ArrowRight', { alt: true }), '\x1b[1;3C');
  assert.equal(key('Home', {}, true), '\x1bOH');
  assert.equal(key('PageDown'), '\x1b[6~');
  assert.equal(key('F1'), '\x1bOP');
  assert.equal(key('F12'), '\x1b[24~');
  assert.equal(key('F5', { ctrl: true }), '\x1b[15;5~');
  assert.equal(key('Enter'), '\r');
  assert.equal(key('Enter', { shift: true }), '\x1b[13;2u');
  assert.equal(key('Enter', { alt: true }), '\x1b\r');
  assert.equal(key('Backspace'), '\x7f');
  assert.equal(key('Delete'), '\x1b[3~');
  assert.equal(key('/', { shift: true }), '?');
  assert.equal(key('x', { alt: true }), '\x1bx');
  assert.equal(key('unknown'), '');
});

test('phone text copy joins visual wrapping and copies the visible viewport, preserving Unicode and spaces', () => {
  const lines = [
    { text: 'older history', isWrapped: false },
    { text: '中文   hello ', isWrapped: false },
    { text: 'world', isWrapped: true },
    { text: 'next line', isWrapped: false },
    { text: '', isWrapped: false },
  ];
  const terminal = { rows: 4, buffer: { active: { viewportY: 1, getLine: row => lines[row] && { ...lines[row], translateToString: trim => trim ? lines[row].text.trimEnd() : lines[row].text } } } };
  assert.equal(terminalScreenText(terminal), '中文   hello world\nnext line');
});
