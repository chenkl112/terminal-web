import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createSocketSender } from '../server/socketSender.js';
import { mergeConversationPatch } from '../shared/conversationPatch.js';
import { reconnectDelay } from '../src/reconnect.js';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 20 * 1024 * 1024;
  frames = [];
  callbacks = [];
  closed = null;
  send(text, callback) { this.frames.push(JSON.parse(text)); this.callbacks.push(callback); }
  drain() { this.callbacks.shift()?.(); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(1006, 'terminated'); }
}

test('large snapshots drain without 1013 and repeated conversation updates coalesce', () => {
  const socket = new Socket(), sender = createSocketSender(socket);
  sender.send({ type: 'snapshot', data: 'x'.repeat(10 * 1024 * 1024) });
  for (let i = 0; i < 100; i++) sender.send({ type: 'conversation', conversation: { id: 'c', revision: i, turns: [] } });
  assert.equal(socket.closed, null); assert.equal(socket.frames.length, 1);
  socket.drain(); assert.equal(socket.frames.length, 2); assert.equal(socket.frames[1].conversation.revision, 99);
  socket.drain(); sender.dispose();
});

test('coalesced patches keep every changed turn and merge with full snapshots', () => {
  const socket = new Socket(), sender = createSocketSender(socket);
  sender.send({ type: 'snapshot' });
  sender.send({ type: 'conversation/updated', conversation: { id: 'c', status: 'active' }, turns: [{ id: 'a', text: 'old' }] });
  sender.send({ type: 'conversation/updated', conversation: { id: 'c', status: 'idle' }, turns: [{ id: 'a', text: 'latest' }, { id: 'b', text: 'second' }] });
  socket.drain();
  const merged = mergeConversationPatch({ id: 'c', turns: [{ id: 'history' }, { id: 'a', text: 'previous' }] }, socket.frames[1]);
  assert.equal(merged.status, 'idle'); assert.deepEqual(merged.turns.map(turn => turn.id), ['history', 'a', 'b']); assert.equal(merged.turns[1].text, 'latest');
  sender.send({ type: 'conversation', conversation: { id: 'c', turns: [{ id: 'history' }] } });
  sender.send({ type: 'conversation/updated', conversation: { id: 'c', status: 'completed' }, turns: [{ id: 'a', text: 'final' }] });
  socket.drain(); assert.equal(socket.frames[2].type, 'conversation'); assert.deepEqual(socket.frames[2].conversation.turns.map(turn => turn.id), ['history', 'a']);
  socket.drain(); sender.dispose();
});

test('terminal output preserves ordering across resets and real backlogs stay bounded', () => {
  const socket = new Socket(), sender = createSocketSender(socket, { maxTerminalChars: 10 });
  sender.send({ type: 'snapshot' });
  sender.send({ type: 'terminal/data', id: 't', data: 'old' });
  sender.send({ type: 'terminal/reset', id: 't' });
  sender.send({ type: 'terminal/data', id: 't', data: 'new' });
  sender.send({ type: 'terminal/data', id: 't', data: '!' });
  socket.drain(); socket.drain(); socket.drain(); socket.drain();
  assert.deepEqual(socket.frames.slice(1).map(frame => frame.type === 'terminal/reset' ? 'reset' : frame.data), ['old', 'reset', 'new!']);
  sender.send({ type: 'snapshot' }); sender.send({ type: 'terminal/data', id: 't', data: 'x'.repeat(11) });
  assert.equal(socket.closed.code, 1013); sender.dispose();
});

test('reconnect backoff increases after rapid disconnects, including server 1013', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(attempt => reconnectDelay(attempt, 1013)), [3000, 6000, 12000, 24000, 30000]);
  assert.equal(reconnectDelay(100, 1006), 30000);
});

test('a real websocket survives a large snapshot followed immediately by active updates', async t => {
  const server = createServer(), wss = new WebSocketServer({ server, path: '/ws' });
  let peakBuffered = 0;
  wss.on('connection', socket => {
    const sender = createSocketSender(socket);
    sender.send({ type: 'snapshot', history: 'x'.repeat(12 * 1024 * 1024) }); peakBuffered = socket.bufferedAmount;
    for (let revision = 0; revision < 100; revision++) sender.send({ type: 'conversation/updated', conversation: { id: 'c', revision }, turns: [{ id: 'current', revision }] });
    sender.send({ type: 'terminal/data', id: 't', data: 'ordered' });
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  t.after(() => { client.terminate(); for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); server.close(); });
  const frames = await new Promise((resolve, reject) => {
    const received = [], timer = setTimeout(() => reject(new Error('websocket did not drain')), 10000);
    client.on('message', raw => { received.push(JSON.parse(raw)); if (received.length === 3) { clearTimeout(timer); resolve(received); } });
    client.on('error', error => { clearTimeout(timer); reject(error); });
    client.on('close', code => { if (received.length < 3) { clearTimeout(timer); reject(new Error(`premature close: ${code}`)); } });
  });
  assert.ok(peakBuffered > 8 * 1024 * 1024); assert.equal(client.readyState, WebSocket.OPEN);
  assert.deepEqual(frames.map(frame => frame.type), ['snapshot', 'conversation/updated', 'terminal/data']);
  assert.equal(frames[1].conversation.revision, 99); assert.equal(frames[2].data, 'ordered');
});
