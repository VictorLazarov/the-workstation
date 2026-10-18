import { defineConfig, devices } from '@playwright/test';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, TOKEN, type E2EState } from './support/env.ts';

/** Asks the OS for a free TCP port (synchronously, so the config object can be built up front). */
function freePort(): number {
  const out = execFileSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' });
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
    execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' }); // shell: `npm` is npm.cmd on Windows
  }
  // realpath.native: macOS /var -> /private/var and Windows 8.3 names (RUNNER~1) must match what git/the server report
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-e2e-')));
  const project = path.join(home, 'project');
  // Fixture project: the mock agent reads src/example.ts, so the @-mention and Read paths are real files.
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src/example.ts'), 'export const greeting = "hello";\n');
  fs.writeFileSync(path.join(project, 'README.md'), '# Fixture project\n');
  for (const d of ['alpha', 'beta', 'gamma']) fs.mkdirSync(path.join(project, d), { recursive: true });
  // The fixture is a git checkout on a branch the mock server does not know ("develop"; the mock reports "main"),
  // with one uncommitted edit and one new file, so the Changes tab and the "one branch everywhere" checks have real data.
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: project, stdio: 'ignore' });
  fs.writeFileSync(path.join(project, 'alpha/.keep'), '');
  // a long tracked file whose every line is edited below: both panes of a split diff are tall and wide enough to scroll
  const longLine = (i: number, tail = '') => `line ${i}: ${'lorem ipsum dolor sit amet, '.repeat(7)}${tail}`;
  fs.writeFileSync(path.join(project, 'long.txt'), Array.from({ length: 70 }, (_, i) => longLine(i)).join('\n') + '\n');
  git('init', '-q', '-b', 'develop');
  git('config', 'user.email', 'e2e@example.com'); git('config', 'user.name', 'e2e'); // the SERVER commits here too (CI runners have no global identity)
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  fs.writeFileSync(path.join(project, 'src/example.ts'), 'export const greeting = "hello, world";\nexport const answer = 42;\nexport function add(a: number, b: number): number { return a + b; }\n');
  fs.writeFileSync(path.join(project, 'long.txt'), Array.from({ length: 70 }, (_, i) => longLine(i, 'EDITED')).join('\n') + '\n');
  fs.writeFileSync(path.join(project, 'NOTES.md'), '# Notes\n\nA new, untracked file.\n');
  // Third fixture (the `fs` project): a repo with ONLY a README, so the mock agent's files land as new folders (src/lib/util.ts).
  const fsProject = path.join(home, 'fs-project');
  fs.mkdirSync(fsProject, { recursive: true });
  fs.writeFileSync(path.join(fsProject, 'README.md'), '# FS fixture\n');
  const fsGit = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: fsProject, stdio: 'ignore' });
  fsGit('init', '-q', '-b', 'main'); fsGit('config', 'user.email', 'e2e@example.com'); fsGit('config', 'user.name', 'e2e'); fsGit('add', '-A'); fsGit('commit', '-q', '-m', 'fixture');
  // Two isolated config homes (one per server) that share the fixed token.
  const mainHome = path.join(home, 'home-main');
  const slowHome = path.join(home, 'home-slow');
  const fsHome = path.join(home, 'home-fs');
  for (const h of [mainHome, slowHome, fsHome]) {
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ token: TOKEN, app: {} }, null, 2), { mode: 0o600 });
  }
  // Snapshot the built web UI so a rebuild elsewhere in the repo cannot break a run mid-way.
  const webSnapshot = path.join(home, 'web-dist');
  fs.cpSync(path.join(repoRoot, 'packages/web/dist'), webSnapshot, { recursive: true });
  return {
    home, project, mainHome, slowHome, webSnapshot, fsHome, fsProject,
    fsUrl: `http://127.0.0.1:${freePort()}`,
    mainUrl: `http://127.0.0.1:${freePort()}`,
    slowUrl: `http://127.0.0.1:${freePort()}`,
  };
}

// Reuse state across the runner and its workers.
const state: E2EState = process.env.E2E_STATE ? JSON.parse(process.env.E2E_STATE) : setup();
process.env.E2E_STATE = JSON.stringify(state);

/**
 * Browsers: chromium always (project names `app` / `live`, as before); firefox and webkit are opt-in because their
 * binaries come from `npx playwright install` (CI only): E2E_BROWSERS=chromium,firefox,webkit.
 * Smoke subset (macOS webkit, Windows chromium): pass the spec files on the command line, see .github/workflows/ci.yml.
 */
const wanted = (process.env.E2E_BROWSERS ?? 'chromium').split(',').map((x) => x.trim()).filter(Boolean);
const viewport = { width: 1280, height: 860 };
const flavours = {
  chromium: { suffix: '', device: devices['Desktop Chrome'], launchOptions: { executablePath: chromePath() } },
  firefox: { suffix: '-firefox', device: devices['Desktop Firefox'], launchOptions: {} },
  webkit: { suffix: '-webkit', device: devices['Desktop Safari'], launchOptions: {} },
} as const;
const mockEnv = (home: string, speed: string) => ({ ...process.env, WORKSTATION_HOME: home, WORKSTATION_MOCK: '1', WORKSTATION_MOCK_SPEED: speed, WORKSTATION_NO_OPEN: '1', WORKSTATION_MAX_SESSIONS: '500', WORKSTATION_WEB_DIST: state.webSnapshot }) as Record<string, string>;
const q = (p: string) => JSON.stringify(p); // paths with spaces (Windows profiles, macOS volumes)
const serverCmd = (url: string, cwd = state.project) => `node ${q(path.join(repoRoot, 'packages/server/dist/cli.js'))} --no-open --host 127.0.0.1 --port ${new URL(url).port} --cwd ${q(cwd)}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  // One worker: the app project's tests share ONE mock server, and every page auto-attaches to all live sessions on it,
  // so parallel tests saw each other's sessions, toasts and 'needs input' rows (the source of run-to-run flakiness).
  workers: 1,
  retries: process.env.CI ? 1 : 0, // CI: one retry, reported as "flaky" (never silently green)
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // E2E_REPORT_DIR / E2E_RESULTS_DIR let CI upload them as artifacts
  reporter: [['list'], ...(process.env.CI ? [['github'] as ['github']] : []), ['html', { open: 'never', outputFolder: process.env.E2E_REPORT_DIR ?? path.join(state.home, 'report') }]],
  outputDir: process.env.E2E_RESULTS_DIR ?? path.join(state.home, 'test-results'),
  use: {
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: (Object.keys(flavours) as Array<keyof typeof flavours>).filter((b) => wanted.includes(b)).flatMap((b) => {
    const fl = flavours[b];
    return [
      // Full-speed mock (WORKSTATION_MOCK_SPEED=0): everything that does not depend on timing.
      { name: `app${fl.suffix}`, testDir: './tests/app', use: { ...fl.device, baseURL: state.mainUrl, viewport, launchOptions: fl.launchOptions } },
      // Slowed mock (speed 0.25): streaming, interrupt, reattach and queueing need a live "running" window.
      { name: `live${fl.suffix}`, testDir: './tests/live', use: { ...fl.device, baseURL: state.slowUrl, viewport, launchOptions: fl.launchOptions } },
      // Honest mock (WORKSTATION_MOCK_FS=1): the agent's Edit/Write really change a throwaway repo, "Always allow" is persisted.
      { name: `fs${fl.suffix}`, testDir: './tests/fs', use: { ...fl.device, baseURL: state.fsUrl, viewport, launchOptions: fl.launchOptions } },
    ];
  }),
  webServer: [
    { command: serverCmd(state.mainUrl), url: state.mainUrl, reuseExistingServer: false, env: mockEnv(state.mainHome, '0'), stdout: 'ignore', stderr: 'pipe', timeout: 60_000 },
    { command: serverCmd(state.slowUrl), url: state.slowUrl, reuseExistingServer: false, env: mockEnv(state.slowHome, '0.25'), stdout: 'ignore', stderr: 'pipe', timeout: 60_000 },
    { command: serverCmd(state.fsUrl, state.fsProject), url: state.fsUrl, reuseExistingServer: false, env: { ...mockEnv(state.fsHome, '0'), WORKSTATION_MOCK_FS: '1' }, stdout: 'ignore', stderr: 'pipe', timeout: 60_000 },
  ],
});
