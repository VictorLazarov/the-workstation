import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCliEnv } from '../src/sdk.js';
import { capHugeToolResults, SessionManager } from '../src/session-manager.js';
import { createMockAdapter } from '../src/mock.js';
import { api, connect, makeServer, startSession, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => { s = await makeServer(); });
afterAll(async () => { await s.close(); });

const isResult = (m: any) => m.type === 'sdk' && m.message.type === 'result';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('provider env', () => {
  it('scrubs inherited credentials only when a provider is configured; configured values win', () => {
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'inherited', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_REMOTE: 'true' };
    expect(buildCliEnv({}, base)).toMatchObject(base);
    const custom = buildCliEnv({ ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_API_KEY: 'mine' }, base);
    expect(custom).toMatchObject({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_API_KEY: 'mine' });
    expect(custom.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(custom.CLAUDE_CODE_REMOTE).toBeUndefined();
    expect(buildCliEnv({ ANTHROPIC_BASE_URL: 'http://x' }, base).ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('permissions with the mock', () => {
  it('remember keeps rules, drops the mode suggestion, and lists them in state; setMode follows', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'bash', clientMsgId: 'a' });
    const req: any = await c.waitFor((m) => m.type === 'permission.request');
    expect(req.suggestions).toHaveLength(1);
    c.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: 'session' } });
    await c.waitFor(isResult);
    const st: any = c.msgs.filter((m) => m.type === 'state').at(-1);
    expect(st.state.rules).toEqual([{ toolName: 'Bash', ruleContent: 'npm test:*', behavior: 'allow', destination: 'session' }]);
    expect(st.state.permissionMode).toBe('default');

    // edit-only suggestion (setMode acceptEdits) is honoured when it is the only way to remember
    c.send({ type: 'prompt', sessionId: sid, text: 'edit', clientMsgId: 'b' });
    const edit: any = await c.waitFor((m) => m.type === 'permission.request' && m.toolName === 'Edit');
    expect(edit.hasSuggestions).toBe(true);
    c.send({ type: 'permission.respond', sessionId: sid, requestId: edit.requestId, decision: { behavior: 'allow', remember: true } });
    await c.waitFor((m: any) => m.type === 'state' && m.state.permissionMode === 'acceptEdits');

    // explicit setMode on approval (ExitPlanMode "approve & auto-accept")
    c.send({ type: 'set.permissionMode', sessionId: sid, mode: 'plan' });
    c.send({ type: 'prompt', sessionId: sid, text: 'plan', clientMsgId: 'c' });
    const plan: any = await c.waitFor((m) => m.type === 'permission.request' && m.toolName === 'ExitPlanMode');
    const mk = c.msgs.length;
    c.send({ type: 'permission.respond', sessionId: sid, requestId: plan.requestId, decision: { behavior: 'allow', setMode: 'default' } });
    await c.waitFor((m: any) => m.type === 'state' && m.state.permissionMode === 'default', 3000, mk);
    expect(s.sessions.get(sid)!.permissionMode).toBe('default');
    await c.waitFor(isResult, 3000, mk);
    // an invalid setMode is rejected without consuming the pending request
    c.send({ type: 'prompt', sessionId: sid, text: 'bash', clientMsgId: 'd' });
    const b2: any = await c.waitFor((m) => m.type === 'permission.request' && m.requestId !== req.requestId && m.toolName === 'Bash');
    const mk2 = c.msgs.length;
    c.send({ type: 'permission.respond', sessionId: sid, requestId: b2.requestId, decision: { behavior: 'allow', setMode: 'bogus' as any } });
    await c.waitFor((m) => m.type === 'error', 3000, mk2);
    expect(s.sessions.get(sid)!.pending.has(b2.requestId)).toBe(true);
    c.send({ type: 'permission.respond', sessionId: sid, requestId: b2.requestId, decision: { behavior: 'deny' } });
    await c.waitFor(isResult, 3000, mk2);
    c.close();
  });

  it('pending requests survive a disconnect by default and are auto-denied after permissionTimeoutSec', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'bash', clientMsgId: 'a' });
    await c.waitFor((m) => m.type === 'permission.request');
    c.close();
    await sleep(400);
    expect(s.sessions.get(sid)!.pending.size).toBe(1); // default: wait forever

    // a new browser re-attaches and gets the request again
    const c2 = await connect(s);
    c2.send({ type: 'session.attach', reqId: 'at', sessionId: sid });
    const again: any = await c2.waitFor((m) => m.type === 'permission.request');
    c2.close();
    await sleep(100);

    s.config.update({ permissionTimeoutSec: 0.3 });
    // arming happens on detach: re-attach then drop again
    const c3 = await connect(s);
    c3.send({ type: 'session.attach', reqId: 'at2', sessionId: sid });
    await c3.waitFor((m) => m.type === 'permission.request');
    c3.close();
    await sleep(1200);
    expect(s.sessions.get(sid)!.pending.size).toBe(0);
    expect(again.requestId).toBeTruthy();
    s.config.update({ permissionTimeoutSec: null });

    // the session continued (command denied) and is usable
    const c4 = await connect(s);
    c4.send({ type: 'session.attach', reqId: 'at3', sessionId: sid });
    await c4.waitFor((m: any) => m.type === 'state' && m.state.status === 'idle');
    c4.close();
  });

  it('a listener that never attaches does not arm the timer; reattaching cancels it', async () => {
    s.config.update({ permissionTimeoutSec: 0.5 });
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'bash', clientMsgId: 'a' });
    await c.waitFor((m) => m.type === 'permission.request');
    await sleep(700);
    expect(s.sessions.get(sid)!.pending.size).toBe(1); // still attached
    c.close();
    await sleep(150);
    const c2 = await connect(s);
    c2.send({ type: 'session.attach', reqId: 'x', sessionId: sid });
    await c2.waitFor((m) => m.type === 'permission.request');
    await sleep(900);
    expect(s.sessions.get(sid)!.pending.size).toBe(1);
    c2.close();
    s.config.update({ permissionTimeoutSec: null });
    s.sessions.close(s.sessions.get(sid)!, 'test');
  });

  it('validates permissionTimeoutSec', () => {
    expect(() => s.config.update({ permissionTimeoutSec: -1 })).toThrow();
    expect(() => s.config.update({ permissionTimeoutSec: 'x' })).toThrow();
    expect(s.config.update({ permissionTimeoutSec: 30 }).permissionTimeoutSec).toBe(30);
    expect(s.config.update({ permissionTimeoutSec: 0 }).permissionTimeoutSec).toBeUndefined();
  });
});

describe('robustness', () => {
  it('a session whose process cannot initialize is torn down and the start request fails', async () => {
    const adapter = createMockAdapter();
    const bad = { ...adapter, query: (p: any) => { const q = adapter.query(p); (q as any).initializationResult = () => Promise.reject(new Error('No conversation found with session ID: x')); return q; } };
    const mgr = new SessionManager(bad as any, s.config, s.cwd);
    const sent: any[] = [];
    await mgr.handle({ id: 't', send: (m) => sent.push(m) }, { type: 'session.start', reqId: 'r', cwd: s.cwd });
    expect(sent.find((m) => m.type === 'error')).toMatchObject({ reqId: 'r', message: expect.stringMatching(/did not initialize.*No conversation found/) });
    expect(sent.some((m) => m.type === 'session.started')).toBe(false);
    expect(mgr.list()).toHaveLength(0);
  });

  it('caps gigantic tool results before they are buffered/forwarded', () => {
    const big = 'x'.repeat(2_500_000);
    const m: any = capHugeToolResults({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }, { type: 'tool_result', tool_use_id: 'u', content: [{ type: 'text', text: big }] }] } });
    expect(m.message.content[0].content.length).toBeLessThan(2_100_000);
    expect(m.message.content[0].content).toContain('omitted by The Workstation');
    expect(m.message.content[1].content[0].text.length).toBeLessThan(2_100_000);
    const small = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };
    expect(capHugeToolResults(small)).toBe(small);
  });
});

describe('worktree cleanup', () => {
  const gitRepo = () => {
    const cwd = fs.mkdtempSync(path.join(s.dir, 'repo-'));
    execSync('git init -q -b main && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m init', { cwd });
    return cwd;
  };

  it('DELETE removes a clean worktree we created, keeps a dirty one (unless force), survives restart', async () => {
    const repo = gitRepo();
    const c = await connect(s);
    const sid = await startSession(c, repo, { worktree: true });
    const live = s.sessions.get(sid)!;
    expect(live.cwd).toContain(path.join('.claude', 'worktrees'));
    expect(fs.existsSync(live.cwd)).toBe(true);
    fs.writeFileSync(path.join(live.cwd, 'dirty.txt'), 'x');

    // registry is persisted next to config.json: a fresh manager (server restart) still knows it
    const reborn = new SessionManager(createMockAdapter(), s.config, s.cwd);
    expect(reborn.worktrees.get(sid)).toMatchObject({ branch: live.worktree!.branch });

    const r1 = await (await api(s, `/api/sessions/${sid}`, { method: 'DELETE' })).json() as any;
    expect(r1.worktree).toMatchObject({ removed: false, reason: expect.stringMatching(/uncommitted/) });
    expect(fs.existsSync(live.cwd)).toBe(true);
    expect(s.sessions.isLive(sid)).toBe(false);

    const r2 = await (await api(s, `/api/sessions/${sid}?force=1`, { method: 'DELETE' })).json() as any;
    expect(r2.worktree).toMatchObject({ removed: true, branchDeleted: true });
    expect(fs.existsSync(live.cwd)).toBe(false);
    expect(execSync('git worktree list', { cwd: repo, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
    c.close();
  });

  it('removes a clean worktree without force, keeps the branch when it has commits, and never touches foreign worktrees', async () => {
    const repo = gitRepo();
    const c = await connect(s);
    const sid = await startSession(c, repo, { worktree: true });
    const live = s.sessions.get(sid)!;
    execSync('git -c user.email=a@b -c user.name=n commit -q --allow-empty -m work', { cwd: live.cwd });
    const res = await s.sessions.removeSessionWorktree(sid, false);
    expect(res).toMatchObject({ removed: true, branchDeleted: false });
    expect(execSync('git branch --list "workstation/*"', { cwd: repo, encoding: 'utf8' })).toContain(live.worktree!.branch);

    // a worktree someone else made is not in the registry => refused
    execSync(`git worktree add -q -b theirs ${path.join(repo, '.claude', 'worktrees', 'theirs')}`, { cwd: repo });
    expect(await s.sessions.removeSessionWorktree('00000000-0000-0000-0000-000000000000', true)).toMatchObject({ removed: false });
    expect(fs.existsSync(path.join(repo, '.claude', 'worktrees', 'theirs'))).toBe(true);
    c.close();
  });
});
