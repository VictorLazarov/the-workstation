/**
 * Helpers for the gated REAL-SDK browser specs (tests/live/real-*.spec.ts, run with REAL_SDK=1). Each spec starts its OWN real server
 * (no mock) on a free port with a throwaway config home and a throwaway git repo, defaults to haiku, and drives the real UI.
 * Never use these with an expensive model: prompts are tiny and the default model is claude-haiku-5-5.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { repoRoot, TOKEN } from './env.ts';

export const REAL = !!process.env.REAL_SDK;
export const HAIKU = 'claude-haiku-5-5';

export interface RealServer { url: string; home: string; repo: string; stop(): Promise<void>; log(): string }

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

/** A throwaway git repository with one commit (hello.txt, app.js). */
export function makeRepo(name = 'repo', extra: (dir: string) => void = () => {}): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `ws-real-${name}-`)));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const n = 1;\n');
  extra(dir);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...a], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  return dir;
}

export async function startRealServer(repo: string, app: Record<string, unknown> = {}): Promise<RealServer> {
  const port = await freePort();
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-real-home-')));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ token: TOKEN, app: { defaultModel: HAIKU, ...app } }), { mode: 0o600 });
  const env = { ...process.env, WORKSTATION_HOME: home, WORKSTATION_NO_OPEN: '1' } as Record<string, string>;
  delete env.WORKSTATION_MOCK;
  const child: ChildProcess = spawn(process.execPath, [path.join(repoRoot, 'packages/server/dist/cli.js'), '--no-open', '--host', '127.0.0.1', '--port', String(port), '--cwd', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout?.on('data', (d) => (log += d)); child.stderr?.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/api/health', { headers: { authorization: 'Bearer ' + TOKEN } })).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url, home, repo, log: () => log,
    stop: async () => { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 300)); if (child.exitCode === null) child.kill('SIGKILL'); },
  };
}

export async function openReal(page: Page, srv: RealServer) {
  await page.goto(`${srv.url}/?token=${TOKEN}`);
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.getByRole('main').getByText('Connecting…')).toHaveCount(0);
}

export async function newRealSession(page: Page) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  const picker = page.getByRole('dialog', { name: 'Open a project' });
  if (await picker.isVisible().catch(() => false)) await picker.getByRole('button', { name: /^Open “/ }).click();
  await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
}

/** Sends a prompt, answers permission cards with Allow once (or Always allow), and waits for the turn to finish. Returns how many cards it answered. */
export async function realTurn(page: Page, text: string, opts: { answer?: 'once' | 'always'; timeout?: number } = {}): Promise<number> {
  const before = await page.locator('.result-line, .banner.error').count();
  const box = page.getByRole('textbox', { name: 'Message Claude' });
  await box.fill(text);
  await box.press('Enter');
  let answered = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < (opts.timeout ?? 120_000)) {
    const allow = page.locator('[data-perm-allow]').first();
    if (await allow.isVisible().catch(() => false)) {
      answered++;
      if (opts.answer === 'always') await page.getByRole('button', { name: 'Always allow' }).first().click(); else await allow.click();
    }
    const idle = (await page.locator('.result-line, .banner.error').count()) > before && (await page.locator('.working').count()) === 0 && !(await allow.isVisible().catch(() => false));
    if (idle) { await page.waitForTimeout(400); return answered; }
    await page.waitForTimeout(700);
  }
  throw new Error(`turn did not finish: ${text}`);
}

/** Saves a screenshot when REAL_SHOTS names a directory (for eyeballing the real UI). */
export async function shot(page: Page, name: string) {
  const dir = process.env.REAL_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

/** Model ids seen in `result` events of this page's WebSocket (what the API really billed). */
export function trackResults(page: Page) {
  const results: Array<{ sid: string; models: string[]; text: string }> = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    try {
      const m = JSON.parse(String(f.payload));
      if (m.type === 'sdk' && m.message?.type === 'result') results.push({ sid: m.sessionId, models: Object.keys(m.message.modelUsage ?? {}), text: String(m.message.result ?? '') });
    } catch { /* not json */ }
  }));
  return results;
}
