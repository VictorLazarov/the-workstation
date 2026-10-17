#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_PORT } from '@workstation/protocol';
import { startServer, VERSION } from './app.js';
import { ConfigStore } from './config.js';

function usage(): never {
  console.log(`workstation ${VERSION}

Usage: workstation [options]
  --port <n>     port to listen on (default ${DEFAULT_PORT}; env PORT)
  --host <addr>  address to bind (default 127.0.0.1; use 0.0.0.0 in containers)
  --cwd <dir>    default project directory (default: current directory)
  --no-open      do not open a browser
  -h, --help     show this help

Env: WORKSTATION_HOME (config dir), WORKSTATION_MOCK=1 (fake SDK), WORKSTATION_ALLOWED_ORIGINS,
     WORKSTATION_ALLOWED_HOSTS (comma separated), WORKSTATION_WEB_DIST.`);
  process.exit(0);
}

function parseArgs(argv: string[]) {
  const o = { port: Number(process.env.PORT) || DEFAULT_PORT, host: '127.0.0.1', cwd: process.cwd(), open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--port')) o.port = Number(val());
    else if (a.startsWith('--host')) o.host = val();
    else if (a.startsWith('--cwd')) o.cwd = path.resolve(val());
    else if (a === '--no-open') o.open = false;
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) { console.error('invalid --port'); process.exit(2); }
  return o;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* ignore */ }
}

const args = parseArgs(process.argv.slice(2));
const config = new ConfigStore();
const running = await startServer({ host: args.host, port: args.port, cwd: args.cwd, config });
console.log(`The Workstation ${VERSION}${process.env.WORKSTATION_MOCK === '1' ? ' [MOCK MODE]' : ''}`);
console.log(`  project: ${args.cwd}`);
console.log(`  config:  ${config.file}`);
console.log(`\n  ${running.url}\n`);
if (args.host !== '127.0.0.1' && args.host !== 'localhost' && args.host !== '::1') {
  console.log(`  Listening on ${args.host}: anyone who can reach this port AND has the token can run commands as you.`);
}
if (args.open && !process.env.CI && process.env.WORKSTATION_NO_OPEN !== '1') openBrowser(running.url);
const stop = async () => { await running.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
