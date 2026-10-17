import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, TOKEN, type E2EState } from './support/env.ts';

/** Asks the OS for a free TCP port (synchronously, so the config object can be built up front). */
function freePort(): number {
  const out = execFileSync(process.execPath, ['-e', 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'], { encoding: 'utf8' });
  return Number(out.trim());
}

/** Finds the preinstalled Chromium (no `playwright install`). E2E_CHROME overrides. */
function chromePath(): string | undefined {
  if (process.env.E2E_CHROME) return process.env.E2E_CHROME;
  const base = '/opt/pw-browsers';
  if (!fs.existsSync(base)) return undefined;
  const builds = fs.readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const b of builds) {
    const dir = path.join(base, b);
    for (const sub of fs.readdirSync(dir).filter((n) => n.startsWith('chrome-linux'))) {
      const p = path.join(dir, sub, 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

function setup(): E2EState {
  const cli = path.join(repoRoot, 'packages/server/dist/cli.js');
  const webIndex = path.join(repoRoot, 'packages/web/dist/index.html');
  if (!fs.existsSync(cli) || !fs.existsSync(webIndex)) {
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-e2e-'));
  const project = path.join(home, 'project');
  // Fixture project: the mock agent reads src/example.ts, so the @-mention and Read paths are real files.
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src/example.ts'), 'export const greeting = "hello";\n');
  fs.writeFileSync(path.join(project, 'README.md'), '# Fixture project\n');
  for (const d of ['alpha', 'beta', 'gamma']) fs.mkdirSync(path.join(project, d), { recursive: true });
  // Two isolated config homes (one per server) that share the fixed token.
  const mainHome = path.join(home, 'home-main');
  const slowHome = path.join(home, 'home-slow');
  for (const h of [mainHome, slowHome]) {
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ token: TOKEN, app: {} }, null, 2), { mode: 0o600 });
  }
  // Snapshot the built web UI so a rebuild elsewhere in the repo cannot break a run mid-way.
  const webSnapshot = path.join(home, 'web-dist');
  fs.cpSync(path.join(repoRoot, 'packages/web/dist'), webSnapshot, { recursive: true });
  return {
    home, project, mainHome, slowHome, webSnapshot,
    mainUrl: `http://127.0.0.1:${freePort()}`,
    slowUrl: `http://127.0.0.1:${freePort()}`,
  };
}

// Reuse state across the runner and its workers.
const state: E2EState = process.env.E2E_STATE ? JSON.parse(process.env.E2E_STATE) : setup();
process.env.E2E_STATE = JSON.stringify(state);

const launchOptions = { executablePath: chromePath() };
const mockEnv = (home: string, speed: string) => ({ ...process.env, WORKSTATION_HOME: home, WORKSTATION_MOCK: '1', WORKSTATION_MOCK_SPEED: speed, WORKSTATION_NO_OPEN: '1', WORKSTATION_WEB_DIST: state.webSnapshot }) as Record<string, string>;
const serverCmd = (url: string) => `node ${path.join(repoRoot, 'packages/server/dist/cli.js')} --no-open --host 127.0.0.1 --port ${new URL(url).port} --cwd ${state.project}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(state.home, 'report') }]],
  outputDir: path.join(state.home, 'test-results'),
  use: {
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions,
  },
  projects: [
    // Full-speed mock (WORKSTATION_MOCK_SPEED=0): everything that does not depend on timing.
    { name: 'app', testDir: './tests/app', use: { ...devices['Desktop Chrome'], baseURL: state.mainUrl, viewport: { width: 1280, height: 860 }, launchOptions } },
    // Slowed mock (speed 0.25): streaming, interrupt, reattach and queueing need a live "running" window.
    { name: 'live', testDir: './tests/live', use: { ...devices['Desktop Chrome'], baseURL: state.slowUrl, viewport: { width: 1280, height: 860 }, launchOptions } },
  ],
  webServer: [
    { command: serverCmd(state.mainUrl), url: state.mainUrl, reuseExistingServer: false, env: mockEnv(state.mainHome, '0'), stdout: 'ignore', stderr: 'pipe', timeout: 60_000 },
    { command: serverCmd(state.slowUrl), url: state.slowUrl, reuseExistingServer: false, env: mockEnv(state.slowHome, '0.25'), stdout: 'ignore', stderr: 'pipe', timeout: 60_000 },
  ],
});
