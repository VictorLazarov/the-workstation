import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogsResponse } from '@workstation/protocol';
import { api, connect, makeServer, startSession, type TestServer } from './helpers.js';

let s: TestServer;
const run = (...a: string[]) => execFileSync('git', a, { cwd: s.cwd, stdio: 'pipe' }).toString();
const logs = async (qs: string) => ((await (await api(s, `/api/logs${qs}`)).json()) as LogsResponse).entries;
beforeAll(async () => {
  s = await makeServer();
  run('init', '-q', '-b', 'main'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  run('add', '.'); run('commit', '-qm', 'init');
});
afterAll(async () => { await s.close(); });

describe('git and worktree operations are logged (names and counts, never contents)', () => {
  it('commit and revert success; a rejecting hook is a warning with its output', async () => {
    fs.writeFileSync(path.join(s.cwd, 'a.txt'), 'secret file content line\n');
    fs.writeFileSync(path.join(s.cwd, 'b.txt'), 'other\n');
    const post = (p: string, body: unknown) => api(s, p, { method: 'POST', body: JSON.stringify(body) });
    expect((await post('/api/git/revert', { cwd: s.cwd, path: 'b.txt' })).status).toBe(200);
    expect((await post('/api/git/commit', { cwd: s.cwd, message: 'add a: private commit message', files: ['a.txt'] })).status).toBe(200);
    const ok = await logs('?source=git&level=info');
    expect(ok.map((e) => e.message)).toEqual(expect.arrayContaining(['Commit created', 'Reverted a file (deleted untracked)']));
    expect(ok.find((e) => e.message === 'Commit created')!.detail).toMatchObject({ files: 1 });
    expect(JSON.stringify(ok)).not.toContain('secret file content');
    expect(JSON.stringify(ok)).not.toContain('private commit message');

    if (process.platform === 'win32') return;
    fs.mkdirSync(path.join(s.cwd, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(s.cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed: token=hookleakedvalue123 in c.txt" >&2\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(s.cwd, 'c.txt'), 'c\n');
    expect((await post('/api/git/commit', { cwd: s.cwd, message: 'c', files: ['c.txt'] })).status).toBe(409);
    const warn = await logs('?source=git&level=warn');
    const e = warn.find((x) => x.message === 'git commit failed');
    expect(e).toBeTruthy();
    expect(JSON.stringify(e!.detail)).toContain('lint failed');
    expect(JSON.stringify(e!.detail)).not.toContain('hookleakedvalue123'); // secrets echoed by a hook are redacted
    expect((await logs('?source=http&q=409')).some((x) => x.detail?.route === '/api/git/commit')).toBe(true);
  });

  it('worktree sessions: created, then removed (or refused) with the reason', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd, { worktree: true });
    const created = await logs(`?source=worktree&sessionId=${sid}`);
    expect(created.map((e) => e.message)).toEqual(['Worktree ready for the session']);
    c.send({ type: 'worktree.remove', reqId: 'w1', sessionId: sid });
    await c.waitFor((m) => m.type === 'ack' && m.reqId === 'w1');
    const after = await logs(`?source=worktree&sessionId=${sid}`);
    expect(after.some((e) => e.level === 'info' && e.message === 'Worktree removed')).toBe(true);
    c.close();
  });
});
