import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { readState, repoRoot, TOKEN } from './env.ts';

/**
 * A private mock server for specs that must not leak state (extra recent projects, sessions, config) into the shared ones.
 * `stop()` kills exactly this process by PID.
 */
export async function startPrivateServer(opts: { cwd: string; env?: Record<string, string> }): Promise<{ base: string; stop: () => void }> {
  const S = readState();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-e2e-private-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ token: TOKEN, app: {} }), { mode: 0o600 });
  const port = await new Promise<number>((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
  const child: ChildProcess = spawn(process.execPath, [path.join(repoRoot, 'packages/server/dist/cli.js'), '--no-open', '--host', '127.0.0.1', '--port', String(port), '--cwd', opts.cwd], {
    env: { ...process.env, WORKSTATION_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude-user'), WORKSTATION_MOCK: '1', WORKSTATION_MOCK_SPEED: '0', WORKSTATION_NO_OPEN: '1', WORKSTATION_WEB_DIST: S.webSnapshot, ...opts.env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  await expect.poll(async () => fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.ok).catch(() => false), { timeout: 20_000 }).toBe(true);
  return { base, stop: () => { child.kill(); try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch { /* the dying server may still be writing its log: a leftover temp dir is harmless */ } } };
}
