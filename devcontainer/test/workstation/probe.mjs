#!/usr/bin/env node
// Black-box probe of a running Workstation server. Dependency free (Node >= 22: global fetch + WebSocket).
// Used by scripts/test-devcontainer.sh (inside the container and from the docker host).
//
//   node probe.mjs --base http://127.0.0.1:7777 --token <t> [--mock] [--local] [--cwd /path/to/git/repo]
//
//   --mock   server runs with WORKSTATION_MOCK=1: also exercise sessions (prompt round trip, worktree)
//   --real-cli  server runs the REAL Agent SDK without credentials: check the bundled claude binary launches (init event,
//           then an authentication error). Proves the native binary for this libc/arch is installed and executable.
//   --local  the probe runs on the same filesystem as the server: also check worktree dirs / terminal cwd
//   --expect-no-token-401-only  (default behaviour) always checks that missing/wrong tokens are rejected
import http from 'node:http';
import fs from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const flag = (n) => process.argv.includes(`--${n}`);
const base = String(arg('base', 'http://127.0.0.1:7777')).replace(/\/$/, '');
const token = String(arg('token', ''));
const mock = flag('mock');
const local = flag('local');
const realCli = flag('real-cli');
const cwd = String(arg('cwd', '/tmp'));
const wsBase = base.replace(/^http/, 'ws');

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw WebSocket upgrade to learn the HTTP status the server answers (the WebSocket API hides it). */
function upgradeStatus(path, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(base);
    const req = http.request({
      host: u.hostname, port: u.port, path, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('workstation-probe').toString('base64'), ...headers,
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(8000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

function openWs(url) {
  const ws = new WebSocket(url);
  const msgs = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const opened = new Promise((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', () => rej(new Error('ws error'))); });
  const waitFor = (pred, ms = 15000) => {
    const hit = msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout; got ${msgs.map((m) => m.type).join(',')}`)), ms);
      waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
    });
  };
  return { ws, msgs, opened, waitFor, send: (m) => ws.send(JSON.stringify(m)) };
}

async function main() {
  // ---- HTTP ----
  const root = await fetch(`${base}/`).catch(() => null);
  ok('GET / serves the SPA without a token', !!root && root.status === 200 && /<html|<!doctype/i.test(await root.text()));
  const csp = root?.headers.get('content-security-policy') ?? '';
  ok('SPA has a CSP header', csp.includes("default-src 'self'"));
  const h0 = await fetch(`${base}/api/health`).catch(() => null);
  ok('/api/health without token -> 401', h0?.status === 401, String(h0?.status));
  const hBad = await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer wrong-token-value' } }).catch(() => null);
  ok('/api/health with a wrong token -> 401', hBad?.status === 401, String(hBad?.status));
  const h1 = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  const health = h1?.status === 200 ? await h1.json() : null;
  ok('/api/health with the token -> 200 {ok:true}', health?.ok === true, health ? `version ${health.version}, mock=${health.mock}` : String(h1?.status));
  if (mock) ok('server reports mock mode', health?.mock === true);
  const fsr = await fetch(`${base}/api/fs/list?path=${encodeURIComponent(cwd)}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  ok('/api/fs/list works with the token', fsr?.status === 200, String(fsr?.status));
  const bad = await fetch(`${base}/api/health`, { headers: { host: 'evil.example', authorization: `Bearer ${token}` } }).catch(() => null);
  // fetch (undici) ignores a forged Host header, so this is only informative; the Host check is covered by server tests.
  void bad;

  // ---- WebSocket auth ----
  ok('/ws without token -> 401', (await upgradeStatus('/ws')) === 401);
  ok('/ws with a wrong token -> 401', (await upgradeStatus('/ws?token=nope')) === 401);
  ok('/ws with a foreign Origin -> 403', (await upgradeStatus(`/ws?token=${token}`, { Origin: 'https://evil.example' })) === 403);
  ok('/ws/terminal without token -> 401', (await upgradeStatus('/ws/terminal?id=x')) === 401);

  // ---- WebSocket hello ----
  const c = openWs(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
  await c.opened;
  const hello = await c.waitFor((m) => m.type === 'hello');
  ok('WS hello', hello.type === 'hello', `version ${hello.version}, serverCwd ${hello.serverCwd}`);

  // ---- sessions (mock) ----
  if (mock) {
    c.send({ type: 'session.start', reqId: 'r1', cwd });
    const started = await c.waitFor((m) => m.type === 'session.started' && m.reqId === 'r1');
    ok('mock session starts', !!started.sessionId);
    c.send({ type: 'prompt', sessionId: started.sessionId, text: 'say hi', clientMsgId: 'm1' });
    const res = await c.waitFor((m) => m.type === 'sdk' && m.message?.type === 'result', 20000).catch(() => null);
    ok('mock prompt round trip ends with a result', !!res);

    // git worktree session in a real git repo
    const repo = String(arg('repo', ''));
    if (repo) {
      c.send({ type: 'session.start', reqId: 'r2', cwd: repo, worktree: true });
      const wt = await c.waitFor((m) => (m.type === 'session.started' && m.reqId === 'r2') || (m.type === 'error' && m.reqId === 'r2'));
      ok('worktree session starts', wt.type === 'session.started', wt.message ?? wt.cwd);
      if (wt.type === 'session.started') {
        ok('worktree cwd differs from the repo and lives under .claude/worktrees', wt.cwd !== repo && wt.cwd.includes('.claude/worktrees'), wt.cwd);
        if (local) ok('worktree directory exists on disk and has a .git file', fs.existsSync(`${wt.cwd}/.git`));
        c.send({ type: 'worktree.remove', reqId: 'r3', sessionId: wt.sessionId, force: true });
        const rm = await c.waitFor((m) => (m.type === 'ack' || m.type === 'error') && m.reqId === 'r3').catch(() => null);
        ok('worktree.remove acks', rm?.type === 'ack', JSON.stringify(rm?.data ?? rm?.message));
        if (local) ok('worktree directory removed', !fs.existsSync(wt.cwd));
      }
    }
  }
  if (realCli) {
    c.send({ type: 'session.start', reqId: 'rc1', cwd });
    const st = await c.waitFor((m) => m.type === 'session.started' && m.reqId === 'rc1').catch(() => null);
    ok('real SDK session starts', !!st);
    if (st) {
      c.send({ type: 'prompt', sessionId: st.sessionId, text: 'say hi', clientMsgId: 'rc-m1' });
      const init = await c.waitFor((m) => m.type === 'sdk' && m.message?.type === 'system' && m.message?.subtype === 'init' && !m.message?.synthetic, 40000).catch(() => null);
      ok('bundled claude binary launched (system/init from the CLI process)', !!init, init?.message?.claude_code_version ?? '');
      const res = await c.waitFor((m) => m.type === 'sdk' && m.message?.type === 'result', 40000).catch(() => null);
      ok('turn finished (auth error expected without credentials)', !!res, String(res?.message?.result ?? '').slice(0, 80));
    }
  }
  c.ws.close();

  // ---- terminal ----
  const t = openWs(`${wsBase}/ws/terminal?id=probe1&cwd=${encodeURIComponent(cwd)}&cols=100&rows=30&token=${encodeURIComponent(token)}`);
  await t.opened.catch(() => {});
  let out = '';
  t.ws.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.data) out += m.data; } catch { /* ignore */ } });
  const ready = await t.waitFor((m) => m.type === 'ready' || m.type === 'unavailable').catch(() => null);
  ok('terminal ready (PTY backend available)', ready?.type === 'ready', ready ? `${ready.backend ?? ''} ${ready.shell ?? ready.message ?? ''}`.trim() : 'no message');
  if (ready?.type === 'ready') {
    t.send({ type: 'input', data: 'echo probe-$((20+22)); id -un; pwd\n' });
    const end = Date.now() + 10000;
    while (Date.now() < end && !/probe-42/.test(out)) await sleep(50);
    ok('terminal echo round trip', /probe-42/.test(out));
    if (local) ok('terminal starts in the requested cwd', out.includes(cwd), cwd);
    t.send({ type: 'kill' });
  }
  t.ws.close();

  console.log(failed ? `\nPROBE FAILED: ${failed} check(s)` : '\nPROBE PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
