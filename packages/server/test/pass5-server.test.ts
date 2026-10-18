/** Scrutiniser pass 5: bypass-permissions capability (M1) and worktree removal that must not kill the session (M2). */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { startServer } from '../src/app.js';
import { bypassCapability } from '../src/bypass.js';
import { ConfigStore } from '../src/config.js';
import { createMockAdapter } from '../src/mock.js';
import { api, connect, makeServer, startSession, type TestServer } from './helpers.js';

describe('bypassCapability', () => {
  it('non-root is always available; root needs IS_SANDBOX=1 or bubblewrap', () => {
    expect(bypassCapability({}, 1000)).toEqual({ available: true });
    const off = bypassCapability({}, 0, {});
    expect(off.available).toBe(false);
    expect(off.reason).toMatch(/root/);
    expect(off.reason).toMatch(/IS_SANDBOX/);
    expect(bypassCapability({ IS_SANDBOX: '0' }, 0, {}).available).toBe(false);
    expect(bypassCapability({ IS_SANDBOX: '1' }, 0, {}).available).toBe(true);
    expect(bypassCapability({ CLAUDE_CODE_BUBBLEWRAP: '1' }, 0, {}).available).toBe(true);
  });
  it('WORKSTATION_ALLOW_BYPASS=0 switches it off for everyone', () => {
    expect(bypassCapability({}, 1000, { WORKSTATION_ALLOW_BYPASS: '0' }).available).toBe(false);
  });
});

describe('sessions never pass allowDangerouslySkipPermissions when bypass is unavailable', () => {
  let s: TestServer;
  const seen: Options[] = [];
  beforeAll(async () => {
    const base = createMockAdapter();
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-p5-'));
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const config = new ConfigStore(path.join(dir, 'home'));
    const run = await startServer({ host: '127.0.0.1', port: 0, config, cwd, webDist: null, adapter: { ...base, query: (p) => { seen.push(p.options); return base.query(p); } } });
    s = Object.assign(run, { base: `http://127.0.0.1:${run.port}`, token: config.token, dir, cwd });
  });
  afterAll(async () => { await s.close(); });

  it('unavailable: flag absent, explicit bypass refused with a code, saved default falls back, health + hello say why', async () => {
    s.sessions.bypass = () => ({ available: false, reason: 'because root' });
    const health = await (await api(s, '/api/health')).json() as any;
    expect(health.bypassPermissions).toEqual({ available: false, reason: 'because root' });

    const c = await connect(s);
    expect(c.msgs.find((m) => m.type === 'hello')).toMatchObject({ bypass: { available: false, reason: 'because root' } });
    const sid = await startSession(c, s.cwd);
    expect(sid).toBeTruthy();
    expect(seen.at(-1)!.allowDangerouslySkipPermissions).toBeUndefined();

    const reqId = 'r1';
    c.send({ type: 'session.start', reqId, cwd: s.cwd, permissionMode: 'bypassPermissions' });
    const err: any = await c.waitFor((m) => m.type === 'error' && (m as any).reqId === reqId);
    expect(err.code).toBe('bypass_unavailable');
    expect(err.message).toBe('because root');

    await api(s, '/api/config', { method: 'PUT', body: JSON.stringify({ defaultPermissionMode: 'bypassPermissions' }) });
    const sid2 = await startSession(c, s.cwd);
    expect(s.sessions.get(sid2)!.permissionMode).toBe('default');

    c.send({ type: 'set.permissionMode', sessionId: sid, mode: 'bypassPermissions', reqId: 'r2' } as any);
    const err2: any = await c.waitFor((m) => m.type === 'error' && (m as any).code === 'bypass_unavailable' && m !== err);
    expect(err2.message).toBe('because root');
    expect(s.sessions.get(sid)!.permissionMode).toBe('default');
    await api(s, '/api/config', { method: 'PUT', body: JSON.stringify({ defaultPermissionMode: 'default' }) });
    c.close();
  });

  it('available: the flag is passed and bypass can be selected', async () => {
    s.sessions.bypass = () => ({ available: true });
    const c = await connect(s);
    const sid = await startSession(c, s.cwd, { permissionMode: 'bypassPermissions' });
    expect(seen.at(-1)!.allowDangerouslySkipPermissions).toBe(true);
    expect(s.sessions.get(sid)!.permissionMode).toBe('bypassPermissions');
    c.close();
  });
});

describe('removing a worktree does not kill the session unless it will really be removed (M2)', () => {
  let s: TestServer;
  beforeAll(async () => { s = await makeServer(); });
  afterAll(async () => { await s.close(); });

  it('dirty worktree without force: refused, session stays live and usable, worktree untouched; with force it is removed', async () => {
    const repo = fs.mkdtempSync(path.join(s.dir, 'repo-'));
    execSync('git init -q -b main && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m init', { cwd: repo });
    const c = await connect(s);
    const sid = await startSession(c, repo, { worktree: true });
    const live = s.sessions.get(sid)!;
    fs.writeFileSync(path.join(live.cwd, 'dirty.txt'), 'x');

    const res = await s.sessions.removeSessionWorktree(sid, false);
    expect(res).toMatchObject({ removed: false, reason: expect.stringMatching(/uncommitted/) });
    expect(s.sessions.isLive(sid)).toBe(true);
    expect(c.msgs.some((m) => m.type === 'session.ended' && (m as any).sessionId === sid)).toBe(false);
    expect(fs.existsSync(path.join(live.cwd, 'dirty.txt'))).toBe(true);
    expect(s.sessions.worktrees.get(sid)).toBeTruthy();

    // same path through the websocket the UI uses
    c.send({ type: 'worktree.remove', sessionId: sid, reqId: 'w1' } as any);
    const ack: any = await c.waitFor((m) => m.type === 'ack' && (m as any).reqId === 'w1');
    expect(ack.data.removed).toBe(false);
    expect(s.sessions.isLive(sid)).toBe(true);

    const forced = await s.sessions.removeSessionWorktree(sid, true);
    expect(forced).toMatchObject({ removed: true });
    expect(s.sessions.isLive(sid)).toBe(false);
    expect(fs.existsSync(live.cwd)).toBe(false);
    c.close();
  });
});

describe('a removed worktree\'s session stays listed under its project (M3)', () => {
  let s: TestServer;
  beforeAll(async () => { s = await makeServer(); });
  afterAll(async () => { await s.close(); });

  it('after removal (and after a registry reload) /api/sessions?cwd=<project> still returns it, flagged worktree.removed; deleting drops it', async () => {
    const repo = fs.mkdtempSync(path.join(s.dir, 'repo-'));
    execSync('git init -q -b main && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m init', { cwd: repo });
    const c = await connect(s);
    const sid = await startSession(c, repo, { worktree: true });
    c.send({ type: 'prompt', sessionId: sid, text: 'hello', clientMsgId: 'm1' });
    await c.waitFor((m) => m.type === 'sdk' && (m as any).message.type === 'result');
    const list = async () => (await (await api(s, `/api/sessions?cwd=${encodeURIComponent(repo)}`)).json() as any[]).find((x) => x.sessionId === sid);
    expect((await list()).worktree.removed).toBeUndefined();

    expect(await s.sessions.removeSessionWorktree(sid, true)).toMatchObject({ removed: true });
    const after = await list();
    expect(after).toBeTruthy();
    expect(after.worktree).toMatchObject({ removed: true, root: fs.realpathSync.native(repo) });
    // history is still readable
    const msgs = await (await api(s, `/api/sessions/${sid}/messages`)).json() as any;
    expect(msgs.messages.length).toBeGreaterThan(0);
    // survives a server restart (registry on disk)
    const { SessionManager } = await import('../src/session-manager.js');
    const reborn = new SessionManager(createMockAdapter(), s.config, s.cwd);
    expect(reborn.worktrees.getAny(sid)?.removedAt).toBeTruthy();
    expect(reborn.worktrees.get(sid)).toBeUndefined();

    await api(s, `/api/sessions/${sid}`, { method: 'DELETE' });
    expect(await list()).toBeUndefined();
    expect(s.sessions.worktrees.getAny(sid)).toBeUndefined();
    c.close();
  });
});
