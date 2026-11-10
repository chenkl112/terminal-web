import { WebSocket } from 'ws';

const latestStateKey = message => ['conversation', 'conversation/updated'].includes(message.type) && message.conversation?.id ? `conversation:${message.conversation.id}`
  : ['codex/status', 'models', 'workspaces', 'approvals'].includes(message.type) ? message.type : null;

// A large initial snapshot is legitimate. Serialize one frame at a time and
// replace pending conversation snapshots, rather than closing healthy clients
// just because that initial frame is still in the OS send queue.
export function createSocketSender(socket, { maxQueuedMessages = 256, maxTerminalChars = 2 * 1024 * 1024, blockedTimeoutMs = 60000 } = {}) {
  const queue = [], latest = new Map();
  let busy = false, disposed = false, terminalChars = 0, timer;
  function dispose() { disposed = true; clearTimeout(timer); queue.length = 0; latest.clear(); terminalChars = 0; }
  socket.once('close', dispose);
  function close(reason) { dispose(); if (socket.readyState === WebSocket.OPEN) socket.close(1013, reason); }
  function flush() {
    if (disposed || busy || socket.readyState !== WebSocket.OPEN) return;
    const entry = queue.shift(); if (!entry) return;
    if (entry.key) latest.delete(entry.key);
    if (entry.message.type === 'terminal/data') terminalChars -= entry.message.data?.length || 0;
    busy = true;
    timer = setTimeout(() => close('数据发送持续阻塞，请重连'), blockedTimeoutMs); timer.unref?.();
    try {
      socket.send(JSON.stringify(entry.message), error => {
        clearTimeout(timer); busy = false;
        if (disposed) return;
        if (error) { dispose(); socket.terminate(); return; }
        flush();
      });
    } catch { dispose(); socket.terminate(); }
  }
  function send(message) {
    if (disposed || socket.readyState !== WebSocket.OPEN) return;
    const key = latestStateKey(message);
    if (key && latest.has(key)) {
      const entry = latest.get(key), previous = entry.message;
      if (message.type === 'conversation/updated' && previous.type === 'conversation/updated') {
        const turns = new Map((previous.turns || []).map(turn => [turn.id, turn]));
        for (const turn of message.turns || []) turns.set(turn.id, turn);
        entry.message = { ...message, turns: [...turns.values()] };
      } else if (message.type === 'conversation/updated' && previous.type === 'conversation') {
        const turns = [...previous.conversation.turns];
        for (const turn of message.turns || []) {
          const index = turns.findIndex(item => item.id === turn.id);
          if (index < 0) turns.push(turn); else turns[index] = turn;
        }
        entry.message = { type: 'conversation', conversation: { ...previous.conversation, ...message.conversation, turns } };
      } else entry.message = message;
    }
    else {
      const last = queue.at(-1);
      if (message.type === 'terminal/data') {
        terminalChars += message.data?.length || 0;
        if (terminalChars > maxTerminalChars) return close('终端输出持续积压，请重连');
      }
      if (message.type === 'terminal/data' && last?.message.type === 'terminal/data' && last.message.id === message.id) {
        last.message = { ...last.message, data: last.message.data + message.data };
      } else {
        const entry = { key, message }; queue.push(entry);
        if (key) latest.set(key, entry);
      }
    }
    if (queue.length > maxQueuedMessages) return close('待同步事件持续积压，请重连');
    flush();
  }
  return { send, dispose };
}
