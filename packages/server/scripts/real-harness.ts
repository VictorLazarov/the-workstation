/** Shared helpers for driving SessionManager against the REAL Agent SDK (used by scripts/ and test/real-sdk.test.ts). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientMessage, ServerMessage } from '@workstation/protocol';
import { ConfigStore } from '../src/config.js';
import { createRealAdapter } from '../src/sdk.js';
import { SessionManager, type Subscriber } from '../src/session-manager.js';

export const MODEL = 'claude-haiku-5-5';

export class Collector implements Subscriber {
  id = Math.random().toString(36).slice(2);
  msgs: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; t: NodeJS.Timeout }> = [];
  send(m: ServerMessage) {
    this.msgs.push(m);
    this.waiters = this.waiters.filter((w) => { if (w.pred(m)) { clearTimeout(w.t); w.resolve(m); return false; } return true; });
  }
  waitFor<T extends ServerMessage = ServerMessage>(pred: (m: ServerMessage) => boolean, timeout = 90_000, from = 0): Promise<T> {
    const hit = this.msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; got: ${this.msgs.map((m) => (m.type === 'sdk' ? `sdk:${(m.message as any).type}` : m.type)).join(',')}`)), timeout);
      this.waiters.push({ pred, resolve: resolve as any, reject, t });
    });
  }
  sdk(sid?: string) { return this.msgs.filter((m) => m.type === 'sdk' && (!sid || m.sessionId === sid)).map((m) => (m as any).message as Record<string, any>); }
  mark() { return this.msgs.length; }
}

export const isResult = (m: ServerMessage) => m.type === 'sdk' && (m.message as any).type === 'result';

export interface Rig { mgr: SessionManager; config: ConfigStore; dir: string; cwd: string; sub: Collector; start(extra?: Record<string, unknown>): Promise<string>; send(m: ClientMessage): Promise<void>; cleanup(): void }

export function makeRig(opts: { env?: Record<string, string>; cwd?: string; config?: Record<string, unknown> } = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-real-'));
  const cwd = opts.cwd ?? path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const config = new ConfigStore(path.join(dir, 'home'));
  if (opts.config) config.update(opts.config);
  const mgr = new SessionManager(createRealAdapter(), config, cwd);
  const sub = new Collector();
  return {
    mgr, config, dir, cwd, sub,
    async start(extra = {}) {
      const reqId = Math.random().toString(36).slice(2);
      await mgr.handle(sub, { type: 'session.start', reqId, cwd, model: MODEL, ...extra } as ClientMessage);
      const m = await sub.waitFor<Extract<ServerMessage, { type: 'session.started' }>>((x) => (x.type === 'session.started' && x.reqId === reqId) || (x.type === 'error' && x.reqId === reqId), 60_000);
      if (m.type !== 'session.started') throw new Error((m as any).message);
      return m.sessionId;
    },
    send: (m) => mgr.handle(sub, m),
    cleanup() { mgr.closeAll(); },
  };
}
