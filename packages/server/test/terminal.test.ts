import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeServer, type TestServer } from './helpers.js';
import { sanitizeEnv, type TerminalServerMsg } from '../src/terminal.js';

let s: TestServer;
beforeEach(async () => { s = await makeServer(); });
afterEach(async () => { await s.close(); });

function open(id: string, opts: { token?: string | null; origin?: string; cwd?: string } = {}) {
  const token = opts.token === undefined ? s.token : opts.token;
  const q = new URLSearchParams({ id, cwd: opts.cwd ?? s.cwd, cols: '100', rows: '30' });
  if (token) q.set('token', token);
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/terminal?${q}`, { headers: opts.origin ? { origin: opts.origin } : {} });
  const msgs: TerminalServerMsg[] = [];
  let text = '';
  ws.on('message', (d) => { const m = JSON.parse(d.toString()) as TerminalServerMsg; msgs.push(m); if (m.type === 'data' || m.type === 'replay') text += m.data; });
  const opened = new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); ws.once('unexpected-response', (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`))); });
  const until = async (re: RegExp, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (re.test(text)) return text; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`timeout waiting for ${re}; got ${JSON.stringify(text.slice(-300))}`);
  };
  return { ws, msgs, opened, until, send: (m: object) => ws.send(JSON.stringify(m)) };
}

describe('/ws/terminal', () => {
  it('rejects missing/bad token, bad origin', async () => {
    await expect(open('a', { token: null }).opened).rejects.toThrow('401');
    await expect(open('a', { token: 'nope' }).opened).rejects.toThrow('401');
    await expect(open('a', { origin: 'https://evil.example' }).opened).rejects.toThrow('403');
  });

  it('echo round-trip, cwd, resize, replay on reattach, kill', async () => {
    const a = open('t1');
    await a.opened;
    a.send({ type: 'resize', cols: 100, rows: 30 });
    await a.until(/\$|#|%|>/ , 8000).catch(() => {});
    a.send({ type: 'input', data: 'echo hello-$((20+22)); pwd; stty size\n' });
    const out = await a.until(/hello-42[\s\S]*\d+ \d+/);
    expect(out).toContain(s.cwd);
    expect(a.msgs[0]).toMatchObject({ type: 'ready', id: 't1' });
    a.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const b = open('t1');
    await b.opened;
    await b.until(/hello-42/);
    expect(b.msgs.some((m) => m.type === 'replay')).toBe(true);
    b.send({ type: 'kill' });
    await new Promise<void>((r) => b.ws.once('close', () => r()));
  });

  it('does not leak server env secrets into the shell', async () => {
    process.env.WORKSTATION_FOO = 'leak-a';
    process.env.MY_SECRET_THING = 'leak-b';
    const a = open('t2');
    await a.opened;
    a.send({ type: 'input', data: 'echo "[$WORKSTATION_FOO|$MY_SECRET_THING]"; env | grep -c ' + s.token.slice(0, 12) + '\n' });
    const out = await a.until(/\[\|\][\s\S]*\n0\r?\n/);
    expect(out).not.toContain('leak-');
    delete process.env.WORKSTATION_FOO; delete process.env.MY_SECRET_THING;
  });

  it('works with the python fallback backend', async () => {
    // spawner is cached per process, so run this check through a fresh module instance
    process.env.WORKSTATION_TERMINAL_BACKEND = 'python';
    const mod = await import('../src/terminal.js?py' as string);
    const sp = await mod.getSpawner();
    delete process.env.WORKSTATION_TERMINAL_BACKEND;
    if ('error' in sp) return; // no python in this environment
    expect(sp.backend).toBe('python-pty');
    const p = sp.spawn('/bin/sh', s.cwd, sanitizeEnv(process.env), 80, 24);
    let out = '';
    p.onData((d: string) => (out += d));
    p.write('echo py-$((6*7)); stty size\nexit\n');
    await new Promise<void>((r) => p.onExit(() => r()));
    expect(out).toContain('py-42');
  });
});

describe('sanitizeEnv', () => {
  it('drops the server\'s own vars and token values, keeps the user\'s dev credentials', () => {
    const e = sanitizeEnv({ PATH: '/bin', WORKSTATION_TOKEN: 'x', GITHUB_TOKEN: 'y', GH_TOKEN: 'z', SSH_AUTH_SOCK: '/tmp/a', FOO: 'has-TOK-inside', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDECODE: '1' }, 'TOK');
    expect(e.PATH).toBe('/bin');
    expect(Object.keys(e).sort()).toEqual(['COLORTERM', 'GH_TOKEN', 'GITHUB_TOKEN', 'PATH', 'SSH_AUTH_SOCK', 'TERM', 'WORKSTATION_TERMINAL']);
  });
});
