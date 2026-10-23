import React, { useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, Copy, CornerDownLeft, Delete, Keyboard, Send } from 'lucide-react';
import { Modal } from './Sidebar.jsx';
import { copyTerminalSelection } from './terminalClipboard.js';
import { terminalKeySequence, terminalScreenText } from '../shared/terminalKeys.js';

const emptyModifiers = { ctrl: false, alt: false, shift: false };
const commonLetters = ['C', 'D', 'Z', 'A', 'E', 'L', 'R', 'T', 'O', 'G', 'B', 'F', 'U', 'W'];
const controlLetters = [...commonLetters, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(letter => !commonLetters.includes(letter))];
const symbols = ['/', '\\', '|', '~', '-', '_', '$', '[', ']', '{', '}', '`'];

export default function TerminalKeyboard({ terminalRef, disabled }) {
  const [draft, setDraft] = useState('');
  const [modifiers, setModifiers] = useState(emptyModifiers);
  const [more, setMore] = useState(false);
  const [screen, setScreen] = useState(null);
  const [copyStatus, setCopyStatus] = useState('');
  const input = useRef(null);
  function press(key, override) {
    if (disabled || !terminalRef.current) return;
    const terminal = terminalRef.current;
    if (key === 'Enter' && draft) { terminal.paste(draft); setDraft(''); }
    const sequence = terminalKeySequence(/^[A-Z]$/.test(key) ? key.toLowerCase() : key, override || modifiers, terminal.modes.applicationCursorKeysMode);
    if (sequence) terminal.input(sequence, true);
    setModifiers(emptyModifiers);
  }
  function insertText() {
    if (disabled || !draft || !terminalRef.current) return;
    terminalRef.current.paste(draft);
    setDraft(''); setModifiers(emptyModifiers);
  }
  function key(keyName, label = keyName, className = '') {
    return <button key={keyName} type="button" className={className} disabled={disabled} aria-label={`终端 ${keyName}`} onPointerDown={event => event.preventDefault()} onClick={() => press(keyName)}>{label}</button>;
  }
  return <div className="terminal-keyboard" role="group" aria-label="终端输入键盘">
    <div className="terminal-keyboard-heading"><span><Keyboard size={14} />终端键盘</span><div><button type="button" aria-label="复制终端屏幕" onClick={() => { setScreen(terminalScreenText(terminalRef.current)); setCopyStatus(''); }}><Copy size={13} />复制屏幕</button><button type="button" aria-label="更多终端按键" aria-expanded={more} onPointerDown={event => event.preventDefault()} onClick={() => setMore(value => !value)}>更多{more ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</button></div></div>
    <div className="terminal-text-entry"><textarea ref={input} aria-label="终端文字输入" placeholder="输入或粘贴文字…" rows={1} value={draft} disabled={disabled} autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="enter" onFocus={() => setMore(false)} onChange={event => setDraft(event.target.value)} /><button type="button" aria-label="输入文字到终端" title="输入文字，回车单独发送" disabled={disabled || !draft} onPointerDown={event => event.preventDefault()} onClick={insertText}><Send size={15} /><span>输入</span></button></div>
    <div className="terminal-key-row">
      {key('Escape', 'Esc')}{key('Tab')}
      {['ctrl', 'alt', 'shift'].map(modifier => <button key={modifier} type="button" className="terminal-modifier" disabled={disabled} aria-label={`终端 ${modifier}`} aria-pressed={modifiers[modifier]} onPointerDown={event => event.preventDefault()} onClick={() => setModifiers(previous => ({ ...previous, [modifier]: !previous[modifier] }))}>{modifier[0].toUpperCase() + modifier.slice(1)}</button>)}
      {key('Backspace', <Delete size={17} />)}
    </div>
    <div className="terminal-key-row">
      {key('ArrowLeft', <ArrowLeft size={18} />)}{key('ArrowUp', <ArrowUp size={18} />)}{key('ArrowDown', <ArrowDown size={18} />)}{key('ArrowRight', <ArrowRight size={18} />)}{key('Delete', 'Del')}{key('Enter', <><CornerDownLeft size={16} /><span>回车</span></>, 'terminal-enter-key')}
    </div>
    {(modifiers.ctrl || modifiers.alt) && <div className="terminal-control-letters" role="group" aria-label="Ctrl 和 Alt 组合字母">{controlLetters.map(letter => key(letter, letter))}</div>}
    {more && <div className="terminal-extra-keys" role="group" aria-label="更多终端按键">
      <div className="terminal-extra-row">{key('Home')}{key('End')}{key('PageUp', 'PgUp')}{key('PageDown', 'PgDn')}{key('Insert', 'Ins')}{key('Space', '空格')}</div>
      <div className="terminal-extra-row">{Array.from({ length: 12 }, (_, index) => key(`F${index + 1}`))}</div>
      <div className="terminal-extra-row">{symbols.map(symbol => key(symbol))}</div>
      <div className="terminal-shortcuts"><button type="button" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => press('C', { ctrl: true })}>Ctrl+C 中断</button><button type="button" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => press('D', { ctrl: true })}>Ctrl+D</button><button type="button" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => press('Z', { ctrl: true })}>Ctrl+Z</button><button type="button" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => press('Tab', { shift: true })}>Shift+Tab</button></div>
    </div>}
    <p className="terminal-keyboard-note">「输入」只填入文字，「回车」提交{modifiers.ctrl || modifiers.alt || modifiers.shift ? ' · 组合键仅应用一次' : ''}</p>
    {screen !== null && <Modal title="复制终端文字" className="terminal-screen-modal" onClose={() => setScreen(null)}><p>长按文字选择复制，也可以复制当前屏幕的全部文字。</p><textarea aria-label="终端屏幕文字" readOnly value={screen} spellCheck={false} /><footer><span role="status">{copyStatus}</span><button type="button" className="primary" disabled={!screen} onClick={async () => { try { setCopyStatus(await copyTerminalSelection({ getSelection: () => screen }) ? '已复制' : '请长按文字选择复制'); } catch { setCopyStatus('请长按文字选择复制'); } }}>复制全部</button></footer></Modal>}
  </div>;
}
