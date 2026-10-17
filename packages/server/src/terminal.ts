/**
 * Integrated terminal: PTY sessions exposed over their own WebSocket route `/ws/terminal?token=&cwd=&id=&cols=&rows=`.
 *
 * SECURITY: this is an arbitrary shell as the server's user. It is gated by exactly the same Host/Origin/token checks
 * as `/ws` (security.ts) and nothing else. Anyone holding the token has full shell access.
 *
 * Backends: `node-pty` (preferred) -> python3 `pty` helper -> unavailable (the UI shows a clear message).
 * Terminals are keyed by client-chosen `id` and outlive the socket (reattach replays scrollback) until `kill`,
 * shell exit, idle reaping (detached for IDLE_REAP_MS) or server shutdown.
 */
import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { extractBearer, isHostAllowed, isOriginAllowed, tokenMatches, type SecurityOptions } from './security.js';

export type TerminalBackend = 'node-pty' | 'python-pty';
export type TerminalServerMsg =
  | { type: 'ready'; id: string; backend: TerminalBackend; shell: string; cwd: string; cols: number; rows: number; alive: boolean }
  | { type: 'replay'; data: string }
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'unavailable'; message: string }
  | { type: 'error'; message: string };
export type TerminalClientMsg =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' };

interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

const SCROLLBACK_BYTES = 512 * 1024;
const MAX_TERMINALS = 32;
const IDLE_REAP_MS = 30 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const PY_HELPER = `
import os, pty, sys, select, signal, fcntl, termios, struct
shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
def setsize(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, '-i'])
setsize(fd, cols, rows)
ctl = 3
buf = b''
alive = True
def reap(*a):
    global alive
    alive = False
signal.signal(signal.SIGCHLD, reap)
stdin = sys.stdin.fileno(); out = sys.stdout.fileno()
while True:
    try:
        r, _, _ = select.select([fd, stdin, ctl], [], [], 0.5)
    except InterruptedError:
        continue
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: d = b''
        if not d: break
        os.write(out, d)
    if stdin in r:
        d = os.read(stdin, 65536)
        if not d: break
        os.write(fd, d)
    if ctl in r:
        d = os.read(ctl, 4096)
        if not d: break
        buf += d
        while b'\\n' in buf:
            line, buf = buf.split(b'\\n', 1)
            try:
                c, rr = line.split(); setsize(fd, int(c), int(rr)); os.kill(pid, signal.SIGWINCH)
            except Exception: pass
    if not alive and fd not in r:
        break
try:
    os.kill(pid, signal.SIGHUP)
except Exception: pass
try:
    _, st = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(st))
except ChildProcessError:
    sys.exit(0)
`;

export interface Spawner {
  backend: TerminalBackend;
  spawn(shell: string, cwd: string, env: Record<string, string>, cols: number, rows: number): PtyLike;
}

let spawnerPromise: Promise<Spawner | { error: string }> | null = null;

async function detectNodePty(): Promise<Spawner | null> {
  try {
    const mod = (await import('node-pty')) as typeof import('node-pty');
    // probe: a broken native build throws on first spawn
    const probe = mod.spawn('/bin/sh', ['-c', 'exit 0'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/' });
    probe.onExit(() => {});
    return {
      backend: 'node-pty',
      spawn(shell, cwd, env, cols, rows) {
        const p = mod.spawn(shell, ['-i'], { name: 'xterm-256color', cols, rows, cwd, env });
        return {
          write: (d) => p.write(d),
          resize: (c, r) => { try { p.resize(c, r); } catch { /* exited */ } },
          kill: () => { try { p.kill(); } catch { /* gone */ } },
          onData: (cb) => { p.onData(cb); },
          onExit: (cb) => { p.onExit((e) => cb(e.exitCode)); },
        };
      },
    };
  } catch {
    return null;
  }
}

function detectPython(): Promise<Spawner | null> {
  return new Promise((resolve) => {
    const c = cpSpawn('python3', ['-c', 'import pty, termios, fcntl'], { stdio: 'ignore' });
    c.on('error', () => resolve(null));
    c.on('exit', (code) => resolve(code === 0 ? pythonSpawner : null));
  });
}

const pythonSpawner: Spawner = {
  backend: 'python-pty',
  spawn(shell, cwd, env, cols, rows) {
    const child: ChildProcess = cpSpawn('python3', ['-I', '-c', PY_HELPER, shell, String(cols), String(rows)], { cwd, env, stdio: ['pipe', 'pipe', 'inherit', 'pipe'] });
    const ctl = child.stdio[3] as NodeJS.WritableStream;
    ctl.on('error', () => {});
    child.stdin!.on('error', () => {});
    return {
      write: (d) => { child.stdin!.write(d); },
      resize: (c, r) => { ctl.write(`${c} ${r}\n`); },
      kill: () => { child.kill('SIGTERM'); },
      onData: (cb) => { child.stdout!.setEncoding('utf8'); child.stdout!.on('data', cb); },
      onExit: (cb) => { child.on('exit', (code) => cb(code)); child.on('error', () => cb(null)); },
    };
  },
};

export function getSpawner(): Promise<Spawner | { error: string }> {
  spawnerPromise ??= (async () => {
    if (process.env.WORKSTATION_TERMINAL_BACKEND !== 'python') {
      const n = await detectNodePty();
      if (n) return n;
    }
    const p = await detectPython();
    if (p) return p;
    return { error: 'No pseudo-terminal backend is available on the server: the node-pty native module failed to load and python3 is not installed. Install build tools and reinstall (npm rebuild node-pty) or install python3.' };
  })();
  return spawnerPromise;
}

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

/** Remove the server's own token/secret env vars (and anything holding the token's value) from the shell env. */
export function sanitizeEnv(env: NodeJS.ProcessEnv, token?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith('WORKSTATION_') || k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_')) continue;
    if (SECRET_NAME.test(k)) continue;
    if (token && v.includes(token)) continue;
    out[k] = v;
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.WORKSTATION_TERMINAL = '1';
  return out;
}

interface Term {
  id: string;
  pty: PtyLike;
  backend: TerminalBackend;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  scrollback: string;
  alive: boolean;
  exitCode: number | null;
  clients: Set<WebSocket>;
  reap?: NodeJS.Timeout;
}

const clampDim = (n: unknown, d: number, max: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(2, Math.floor(n))) : d);

export interface TerminalService {
  /** Handle an `/ws/terminal` upgrade. Applies the same Host/Origin/token checks as `/ws`. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void;
  closeAll(): void;
  count(): number;
}

export function createTerminalService(opts: { security: SecurityOptions; token: () => string; defaultCwd: string }): TerminalService {
  const terms = new Map<string, Term>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const refuse = (socket: Duplex, code: number, text: string) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  const send = (ws: WebSocket, m: TerminalServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  const broadcast = (t: Term, m: TerminalServerMsg) => { for (const c of t.clients) send(c, m); };

  function armReap(t: Term) {
    if (t.reap) clearTimeout(t.reap);
    t.reap = undefined;
    if (t.clients.size === 0) {
      t.reap = setTimeout(() => destroy(t), IDLE_REAP_MS);
      t.reap.unref();
    }
  }
  function destroy(t: Term) {
    if (t.reap) clearTimeout(t.reap);
    terms.delete(t.id);
    if (t.alive) { t.alive = false; t.pty.kill(); }
    for (const c of t.clients) c.close(1000, 'terminal closed');
    t.clients.clear();
  }

  async function create(id: string, cwd: string, cols: number, rows: number, sp: Spawner): Promise<Term> {
    const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const pty = sp.spawn(shell, cwd, sanitizeEnv(process.env, opts.token()), cols, rows);
    const t: Term = { id, pty, backend: sp.backend, shell, cwd, cols, rows, scrollback: '', alive: true, exitCode: null, clients: new Set() };
    pty.onData((d) => {
      t.scrollback += d;
      if (t.scrollback.length > SCROLLBACK_BYTES) t.scrollback = t.scrollback.slice(-SCROLLBACK_BYTES);
      broadcast(t, { type: 'data', data: d });
    });
    pty.onExit((code) => {
      if (!t.alive && !terms.has(id)) return;
      t.alive = false;
      t.exitCode = code;
      broadcast(t, { type: 'exit', code });
    });
    terms.set(id, t);
    return t;
  }

  async function attach(ws: WebSocket, url: URL) {
    const sp = await getSpawner();
    if ('error' in sp) { send(ws, { type: 'unavailable', message: sp.error }); ws.close(1011, 'unavailable'); return; }
    const id = url.searchParams.get('id') ?? '';
    if (!ID_RE.test(id)) { send(ws, { type: 'error', message: 'invalid terminal id' }); ws.close(1008); return; }
    const cols = clampDim(Number(url.searchParams.get('cols')), 80, 500);
    const rows = clampDim(Number(url.searchParams.get('rows')), 24, 200);
    let t = terms.get(id);
    if (!t) {
      if (terms.size >= MAX_TERMINALS) { send(ws, { type: 'error', message: `too many terminals (max ${MAX_TERMINALS})` }); ws.close(1008); return; }
      const cwd = url.searchParams.get('cwd') || opts.defaultCwd;
      let dir = opts.defaultCwd;
      try { if (fs.statSync(cwd).isDirectory()) dir = cwd; } catch { /* fall back to default */ }
      try { t = await create(id, dir, cols, rows, sp); }
      catch (e) { send(ws, { type: 'unavailable', message: `Failed to start shell: ${e instanceof Error ? e.message : String(e)}` }); ws.close(1011); return; }
    }
    const term = t;
    if (ws.readyState !== ws.OPEN) { armReap(term); return; }
    term.clients.add(ws);
    armReap(term);
    send(ws, { type: 'ready', id, backend: term.backend, shell: term.shell, cwd: term.cwd, cols: term.cols, rows: term.rows, alive: term.alive });
    if (term.scrollback) send(ws, { type: 'replay', data: term.scrollback });
    if (!term.alive) send(ws, { type: 'exit', code: term.exitCode });
    ws.on('message', (raw) => {
      let m: TerminalClientMsg;
      try { m = JSON.parse(raw.toString()) as TerminalClientMsg; } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'input' && typeof m.data === 'string' && term.alive) term.pty.write(m.data);
      else if (m.type === 'resize' && term.alive) {
        term.cols = clampDim(m.cols, term.cols, 500); term.rows = clampDim(m.rows, term.rows, 200);
        term.pty.resize(term.cols, term.rows);
      } else if (m.type === 'kill') destroy(term);
    });
    const gone = () => { term.clients.delete(ws); if (terms.has(term.id)) armReap(term); };
    ws.on('close', gone);
    ws.on('error', gone);
  }

  return {
    upgrade(req, socket, head, url) {
      if (!isHostAllowed(req.headers.host, opts.security)) return refuse(socket, 403, 'Forbidden');
      if (!isOriginAllowed(req.headers.origin, req.headers.host, opts.security)) return refuse(socket, 403, 'Forbidden');
      const token = url.searchParams.get('token') ?? extractBearer(req.headers.authorization);
      if (!tokenMatches(token, opts.token())) return refuse(socket, 401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => {
        // register message handling only after attach; buffer nothing (client waits for 'ready')
        void attach(ws, url).catch(() => ws.close(1011));
      });
    },
    closeAll() {
      for (const t of [...terms.values()]) destroy(t);
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
    count: () => terms.size,
  };
}
