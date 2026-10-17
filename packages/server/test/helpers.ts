import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@workstation/protocol';
import { startServer, type RunningServer } from '../src/app.js';
import { ConfigStore } from '../src/config.js';
import { createMockAdapter } from '../src/mock.js';

process.env.WORKSTATION_MOCK_SPEED = '0';

export interface TestServer extends RunningServer { base: string; token: string; dir: string; cwd: string }

export async function makeServer(extra: { security?: Parameters<typeof startServer>[0] extends infer O ? (O extends { security?: infer S } ? S : never) : never } = {}): Promise<TestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'example.ts'), 'export const greeting = "hello";\n');
  const config = new ConfigStore(path.join(dir, 'home'));
  const s = await startServer({ host: '127.0.0.1', port: 0, config, adapter: createMockAdapter(), cwd, webDist: null, ...extra });
  return Object.assign(s, { base: `http://127.0.0.1:${s.port}`, token: config.token, dir, cwd });
}

export function api(s: TestServer, p: string, init: RequestInit = {}, token: string | null = s.token) {
  return fetch(s.base + p, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) } });
}

/** Raw HTTP request so we can forge Host / Origin headers. */
export function raw(s: TestServer, p: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: p, headers, method: 'GET', setHost: false }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

export class Client {
  msgs: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { w.resolve(m); return false; } return true; });
    });
  }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  waitFor<T extends ServerMessage = ServerMessage>(pred: (m: ServerMessage) => boolean, timeout = 8000, from = 0): Promise<T> {
    const hit = this.msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; got: ${this.msgs.map((m) => m.type).join(',')}`)), timeout);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m as T); } });
    });
  }
  close() { this.ws.close(); }
}

export function connect(s: TestServer, opts: { token?: string | null; origin?: string } = {}): Promise<Client> {
  const token = opts.token === undefined ? s.token : opts.token;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws${token ? `?token=${token}` : ''}`, { headers: opts.origin ? { origin: opts.origin } : {} });
    const c = new Client(ws);
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

export async function startSession(c: Client, cwd: string, extra: Record<string, unknown> = {}) {
  const reqId = Math.random().toString(36).slice(2);
  c.send({ type: 'session.start', reqId, cwd, ...extra } as ClientMessage);
  const m = await c.waitFor<Extract<ServerMessage, { type: 'session.started' }>>((x) => x.type === 'session.started' && x.reqId === reqId);
  return m.sessionId;
}

export const sdkMsgs = (c: Client, sid: string) => c.msgs.filter((m) => m.type === 'sdk' && m.sessionId === sid).map((m) => (m as Extract<ServerMessage, { type: 'sdk' }>).message as Record<string, any>);

/** Symlink creation needs a privilege on Windows (Developer Mode / elevation): tests that need links skip when it is missing. */
export function canSymlink(): boolean {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sl-'));
  try { fs.symlinkSync(d, path.join(d, 'l')); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
export const isWindows = process.platform === 'win32';
