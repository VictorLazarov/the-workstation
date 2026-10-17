// Boots the BUILT CLI (dist/cli.js) in mock mode on a free port and checks health, auth and the SPA. Runs on every OS in CI.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'packages/server/dist/cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws smoke '));
const child = spawn(process.execPath, [cli, '--no-open', '--port', '0', '--cwd', home], {
  env: { ...process.env, WORKSTATION_HOME: home, WORKSTATION_MOCK: '1', WORKSTATION_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
const fail = (m) => { console.error('SMOKE FAILED:', m); child.kill(); process.exit(1); };
const timer = setTimeout(() => fail('no URL printed within 30s:\n' + out), 30_000);
child.on('exit', (c) => { if (c) fail(`server exited with ${c}`); });
child.stdout.on('data', async (d) => {
  out += d;
  const m = /(http:\/\/[^\s]+\/\?token=([\w-]+))/.exec(out);
  if (!m) return;
  child.stdout.removeAllListeners('data');
  clearTimeout(timer);
  try {
    const base = new URL(m[1]).origin;
    const health = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${m[2]}` } });
    if (!health.ok || !(await health.json()).ok) fail('health not ok');
    if ((await fetch(`${base}/api/health`)).status !== 401) fail('unauthenticated request was not refused');
    const page = await fetch(base + '/');
    const html = await page.text();
    if (!page.ok || !html.includes('id="root"')) fail('SPA index.html not served (web dist missing?)');
    if (!(page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'")) fail('CSP header missing');
    console.log(`smoke ok on ${process.platform} (${base})`);
    child.kill();
    process.exit(0);
  } catch (e) { fail(String(e)); }
});
