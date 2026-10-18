/** Worktree summaries/init, MCP status redaction, remembered permission rules and rewind-by-fork against the mock SDK. */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listPermissionRules, removeLocalPermissionRule, settingsProjectDir } from '../src/permission-rules.js';
import { publicMcpStatus } from '../src/session-manager.js';
import { api, connect, makeServer, sdkMsgs, startSession, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => { s = await makeServer(); });
afterAll(async () => { await s.close(); });

const tmp = (n: string) => fs.mkdtempSync(path.join(s.dir, n + '-'));

describe('worktree sessions are filed under their project', () => {
  it('start: init carries worktree + root; /api/sessions reports worktree.root for live and resumed sessions', async () => {
    const repo = tmp('repo');
    execSync('git init -q -b main && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m init', { cwd: repo });
    const c = await connect(s);
    const sid = await startSession(c, repo, { worktree: true });
    const live = s.sessions.get(sid)!;
    expect(live.worktree).toMatchObject({ branch: expect.stringMatching(/^workstation\//), root: fs.realpathSync(repo) });
    const list = await (await api(s, `/api/sessions?cwd=${encodeURIComponent(live.cwd)}`)).json() as any[];
    expect(list.find((x) => x.sessionId === sid)?.worktree).toMatchObject({ root: fs.realpathSync(repo), branch: live.worktree!.branch });
    // a plain session has no worktree field
    const plain = await startSession(c, repo);
    const all = await (await api(s, `/api/sessions?cwd=${encodeURIComponent(repo)}`)).json() as any[];
    expect(all.find((x) => x.sessionId === plain)?.worktree).toBeUndefined();
    // resume from the worktree directory itself (what the sidebar does): still a worktree session
    c.send({ type: 'session.close', sessionId: sid });
    await new Promise((r) => setTimeout(r, 200));
    const again = await startSession(c, live.cwd, { resume: sid });
    expect(again).toBe(sid);
    expect(s.sessions.get(sid)!.worktree).toMatchObject({ branch: live.worktree!.branch, root: fs.realpathSync(repo) });
    c.close();
  });
});

describe('MCP status shown to browsers', () => {
  it('keeps name, status, error, tool names; drops launch config (args, URLs, env)', () => {
    const out = publicMcpStatus([
      { name: 'a', status: 'connected', serverInfo: { name: 'a', version: '1' }, config: { type: 'stdio', command: 'node', args: ['--token=SECRET'], env: { K: 'V' } }, scope: 'project', tools: [{ name: 'ping', annotations: {} }] },
      { name: 'b', status: 'failed', error: 'Connection closed', config: { type: 'http', url: 'https://x/?key=SECRET' } },
      { nope: true }, null,
    ]);
    expect(out).toEqual([
      { name: 'a', status: 'connected', scope: 'project', tools: ['ping'], serverInfo: { name: 'a', version: '1' } },
      { name: 'b', status: 'failed', error: 'Connection closed' },
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(publicMcpStatus(undefined)).toEqual([]);
  });
  it('mcp.status answers with the same ack as toggle/reconnect', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'mcp.status', sessionId: sid });
    const ack = await c.waitFor<any>((m) => m.type === 'ack' && m.reqId === `mcp:${sid}`);
    expect(ack.data.mcpServers.map((x: any) => x.name)).toEqual(['mock-mcp', 'docs']);
    expect(ack.data.mcpServers[0]).not.toHaveProperty('config');
    c.close();
  });
});

describe('remembered permission rules', () => {
  const settings = (dir: string, rel: string, v: unknown) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(v)); };

  it('lists local (removable), project and user (read-only) rules; removing touches only the local file and keeps other keys', () => {
    const dir = tmp('rules');
    const home = tmp('claudehome');
    settings(dir, '.claude/settings.local.json', { enableAllProjectMcpServers: true, permissions: { allow: ['Bash(touch a)', 'mcp__mini__ping'], deny: ['Read(./.env)'] } });
    settings(dir, '.claude/settings.json', { permissions: { allow: ['Bash(npm test)'] } });
    settings(home, 'settings.json', { permissions: { ask: ['Bash(git push:*)'] } });
    const rules = listPermissionRules(dir, { CLAUDE_CONFIG_DIR: home });
    expect(rules).toEqual([
      { source: 'local', behavior: 'allow', rule: 'Bash(touch a)', removable: true },
      { source: 'local', behavior: 'allow', rule: 'mcp__mini__ping', removable: true },
      { source: 'local', behavior: 'deny', rule: 'Read(./.env)', removable: true },
      { source: 'project', behavior: 'allow', rule: 'Bash(npm test)', removable: false },
      { source: 'user', behavior: 'ask', rule: 'Bash(git push:*)', removable: false },
    ]);
    expect(removeLocalPermissionRule(dir, 'allow', 'Bash(touch a)')).toEqual({ removed: true });
    expect(removeLocalPermissionRule(dir, 'allow', 'Bash(touch a)')).toEqual({ removed: false });
    const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
    expect(after).toEqual({ enableAllProjectMcpServers: true, permissions: { allow: ['mcp__mini__ping'], deny: ['Read(./.env)'] } });
    // emptied lists / permissions disappear, other keys stay
    removeLocalPermissionRule(dir, 'allow', 'mcp__mini__ping'); removeLocalPermissionRule(dir, 'deny', 'Read(./.env)');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'))).toEqual({ enableAllProjectMcpServers: true });
    expect(() => removeLocalPermissionRule(dir, 'bogus', 'x')).toThrow(/behavior/);
    expect(() => removeLocalPermissionRule(dir, 'allow', '')).toThrow(/rule/);
    // the project file is never edited
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'))).toEqual({ permissions: { allow: ['Bash(npm test)'] } });
  });

  it('rules belong to the main checkout: a sub-directory or a linked worktree resolves to the repository root', async () => {
    const repo = fs.realpathSync(tmp('proj'));
    execSync('git init -q -b main && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m init', { cwd: repo });
    fs.mkdirSync(path.join(repo, 'sub'));
    execSync(`git worktree add -q -b wt ${path.join(repo, '.claude', 'worktrees', 'w1')}`, { cwd: repo });
    expect(await settingsProjectDir(repo)).toBe(repo);
    expect(await settingsProjectDir(path.join(repo, 'sub'))).toBe(repo);
    expect(await settingsProjectDir(path.join(repo, '.claude', 'worktrees', 'w1'))).toBe(repo);
    const plain = fs.realpathSync(tmp('nogit'));
    expect(await settingsProjectDir(plain)).toBe(plain);
  });

  it('REST: GET lists, DELETE removes (token required, bad input is 400)', async () => {
    const dir = tmp('restrules');
    settings(dir, '.claude/settings.local.json', { permissions: { allow: ['Bash(ls)'] } });
    const got = await (await api(s, `/api/permission-rules?cwd=${encodeURIComponent(dir)}`)).json() as any;
    expect(got.dir).toBe(dir);
    expect(got.rules.filter((r: any) => r.source === 'local')).toEqual([{ source: 'local', behavior: 'allow', rule: 'Bash(ls)', removable: true }]);
    expect((await api(s, `/api/permission-rules?cwd=${encodeURIComponent(dir)}`, {}, null)).status).toBe(401);
    expect((await api(s, '/api/permission-rules', { method: 'DELETE', body: JSON.stringify({ cwd: dir, behavior: 'nope', rule: 'x' }) })).status).toBe(400);
    const del = await (await api(s, '/api/permission-rules', { method: 'DELETE', body: JSON.stringify({ cwd: dir, behavior: 'allow', rule: 'Bash(ls)' }) })).json() as any;
    expect(del).toEqual({ removed: true });
    expect(listPermissionRules(dir, { CLAUDE_CONFIG_DIR: tmp('empty') })).toEqual([]);
  });
});

describe('rewind the conversation (fork from before a message)', () => {
  it('rewindBefore branches the transcript before that user message; the first message cannot be rewound', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    const send = async (text: string, n: number) => {
      c.send({ type: 'prompt', sessionId: sid, text, clientMsgId: 'm' + n });
      await c.waitFor((m) => m.type === 'sdk' && m.sessionId === sid && (m.message as any).type === 'result' && sdkMsgs(c, sid).filter((x) => x.type === 'result').length >= n, 15000);
    };
    await send('first question', 1);
    await send('second question', 2);
    const users = sdkMsgs(c, sid).filter((m) => m.type === 'user' && m.origin === 'workstation').map((m) => m.uuid as string);
    expect(users).toHaveLength(2);
    // second message: the fork keeps turn 1 only
    const reqId = 'rw1';
    c.send({ type: 'session.start', reqId, cwd: s.cwd, resume: sid, fork: true, rewindBefore: users[1] });
    const started = await c.waitFor<any>((m) => m.type === 'session.started' && m.reqId === reqId);
    expect(started.sessionId).not.toBe(sid);
    c.send({ type: 'prompt', sessionId: started.sessionId, text: 'third', clientMsgId: 'm3' });
    await c.waitFor((m) => m.type === 'sdk' && m.sessionId === started.sessionId && (m.message as any).type === 'result', 15000);
    const hist = (await (await api(s, `/api/sessions/${started.sessionId}/messages`)).json() as any).messages as any[];
    const texts = JSON.stringify(hist.map((m) => m.message?.content));
    expect(texts).toContain('first question');
    expect(texts).not.toContain('second question');
    expect(texts).toContain('third');
    // the original stays whole
    const orig = (await (await api(s, `/api/sessions/${sid}/messages`)).json() as any).messages as any[];
    expect(JSON.stringify(orig.map((m) => m.message?.content))).toContain('second question');
    // first message: refused with a clear reason
    c.send({ type: 'session.start', reqId: 'rw2', cwd: s.cwd, resume: sid, fork: true, rewindBefore: users[0] });
    const err = await c.waitFor<any>((m) => m.type === 'error' && m.reqId === 'rw2');
    expect(err.message).toMatch(/first message/);
    c.close();
  }, 30_000);
});
