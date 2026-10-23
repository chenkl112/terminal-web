import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function localEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') delete env[key];
  }
  delete env.NO_COLOR;
  return env;
}

export class Codex extends EventEmitter {
  pending = new Map();
  sequence = 0;
  status = 'starting';
  async start() {
    this.process = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio'], {
      env: localEnv(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.on('error', error => this.died(error));
    this.process.on('exit', (code, signal) => this.died(new Error(`Codex 已断开 (${signal || code})`)));
    this.process.stderr.on('data', data => {
      // Keep diagnostics on the host; never forward configuration or credentials to browsers.
      if (process.env.DEBUG_CODEX) process.stderr.write(data);
    });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        this.emit(message.id === undefined ? 'notification' : 'request', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
    await this.call('initialize', {
      clientInfo: { name: 'mono_workspace', title: 'Mono Workspace', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
    this.status = 'ready';
    this.emit('status', this.status);
  }
  write(message) {
    if (!this.process?.stdin.writable) throw new Error('Codex 尚未连接');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  died(error) {
    if (this.status === 'offline') return;
    this.status = 'offline';
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.emit('status', this.status);
  }
  close() { this.process?.kill('SIGTERM'); }
}
