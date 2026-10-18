/** A repo with no git user.name/email: Commit must say so (it used to leave the UI waiting with nothing useful). */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Isolate git from the machine's identity BEFORE the server module (which captures process.env) is loaded.
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];
const { api, makeServer } = await import('./helpers.js');
type TestServer = Awaited<ReturnType<typeof makeServer>>;

let s: TestServer;
const run = (...a: string[]) => execFileSync('git', a, { cwd: s.cwd, stdio: 'pipe' }).toString();
beforeAll(async () => {
  s = await makeServer();
  run('init', '-q', '-b', 'main');
  run('config', 'user.useConfigOnly', 'true'); // never guess an identity from the hostname
  run('add', '.'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
});
afterAll(async () => { await s.close(); });

describe('commit without a git identity', () => {
  it('fails fast with an actionable 409 naming git config, and the next commit works once identity is set', async () => {
    fs.writeFileSync(path.join(s.cwd, 'src', 'new.ts'), 'x\n');
    const post = () => api(s, '/api/git/commit', { method: 'POST', body: JSON.stringify({ cwd: s.cwd, message: 'add new', files: ['src/new.ts'] }) });
    const r = await post();
    expect(r.status).toBe(409);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/name and email/);
    expect(body.error).toMatch(/git config/);
    expect(body.error).not.toMatch(/hook/);
    run('config', 'user.name', 'Test'); run('config', 'user.email', 't@example.com');
    expect((await post()).status).toBe(200);
  });
});
