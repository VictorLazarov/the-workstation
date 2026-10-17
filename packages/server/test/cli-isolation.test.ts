/**
 * M2 (scrutiniser pass 1): with a custom endpoint configured, NO inherited credential may reach it. Runs the REAL
 * Claude Code CLI (bundled with the SDK) against a local capture "provider" that records every request (all headers and
 * the body) and answers 401. No real API call is made. Skipped when the CLI binary is not installed (or CLI_ISOLATION=0).
 *
 * Planted credential sources (all must stay invisible to the provider):
 *  - a fake HOME with ~/.claude/.credentials.json (OAuth), ~/.claude/settings.json (apiKeyHelper + env headers/keys),
 *    ~/.claude.json (primaryApiKey)
 *  - inherited env: ANTHROPIC_API_KEY/AUTH_TOKEN/CUSTOM_HEADERS, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_REMOTE*, container and
 *    session ids, GH_TOKEN, AWS keys
 *  - the container's real well-known credential files (/home/claude/.claude/remote/.oauth_token, .api_key), if present
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Collector, makeRig, type Rig } from '../scripts/real-harness.js';

const require = createRequire(import.meta.url);
function cliInstalled(): boolean {
  if (process.env.CLI_ISOLATION === '0') return false;
  for (const p of ['@anthropic-ai/claude-agent-sdk-linux-x64/claude', '@anthropic-ai/claude-agent-sdk-linux-arm64/claude', '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude', '@anthropic-ai/claude-agent-sdk-darwin-x64/claude', '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', '@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe']) {
    try { require.resolve(p); return true; } catch { /* next */ }
  }
  return false;
}

interface Captured { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }

const SECRETS: Record<string, string> = {
  credentialsFile: 'sk-ant-oat01-FAKE-CREDENTIALS-FILE-TOKEN',
  helperKey: 'sk-ant-api03-FAKE-API-KEY-HELPER',
  settingsEnvKey: 'sk-ant-api03-FAKE-SETTINGS-ENV-KEY',
  settingsHeader: 'settings-corp-sso-SECRET',
  primaryApiKey: 'sk-ant-api03-FAKE-PRIMARY-API-KEY',
  envApiKey: 'sk-ant-api03-FAKE-INHERITED-ENV-KEY',
  envAuthToken: 'FAKE-INHERITED-AUTH-TOKEN',
  envOauth: 'sk-ant-oat01-FAKE-INHERITED-OAUTH',
  customHeader: 'corp-sso-SECRET',
  remoteSession: 'FAKE-REMOTE-SESSION-ID-123',
  container: 'FAKE-CONTAINER-ID-456',
  gh: 'ghp_FAKEGITHUBTOKEN',
  aws: 'FAKEAWSSECRETACCESSKEY',
};
// Real well-known files of a Claude Code remote container: compared in memory only, never printed.
for (const f of ['/home/claude/.claude/remote/.oauth_token', '/home/claude/.claude/remote/.api_key']) {
  try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) SECRETS[`wellKnown:${path.basename(f)}`] = v; } catch { /* absent */ }
}

let captured: Captured[] = [];
let provider: http.Server;
let providerUrl = '';
const savedEnv = { ...process.env };
let fakeHome = '';

beforeAll(async () => {
  provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      captured.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fakehome-'));
  const cdir = path.join(fakeHome, '.claude');
  fs.mkdirSync(path.join(cdir, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(cdir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRETS.credentialsFile, refreshToken: 'r', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference'] } }));
  fs.writeFileSync(path.join(cdir, 'settings.json'), JSON.stringify({ apiKeyHelper: `echo ${SECRETS.helperKey}`, env: { ANTHROPIC_API_KEY: SECRETS.settingsEnvKey, ANTHROPIC_CUSTOM_HEADERS: `X-Settings-Sso: ${SECRETS.settingsHeader}`, SAFE_SETTING: '1' }, includeCoAuthoredBy: false }));
  fs.writeFileSync(path.join(cdir, 'CLAUDE.md'), '# user memory\n');
  fs.writeFileSync(path.join(cdir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\nhi\n');
  fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({ primaryApiKey: SECRETS.primaryApiKey, oauthAccount: { emailAddress: 'x@y' }, hasCompletedOnboarding: true, mcpServers: {} }));

  for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC_|CCR_)/.test(k)) delete process.env[k];
  Object.assign(process.env, {
    HOME: fakeHome, USERPROFILE: fakeHome, // os.homedir() reads USERPROFILE on Windows
    ANTHROPIC_API_KEY: SECRETS.envApiKey, ANTHROPIC_AUTH_TOKEN: SECRETS.envAuthToken, CLAUDE_CODE_OAUTH_TOKEN: SECRETS.envOauth,
    ANTHROPIC_CUSTOM_HEADERS: `X-Corp-Sso: ${SECRETS.customHeader}`,
    CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: SECRETS.remoteSession, CLAUDE_CODE_CONTAINER_ID: SECRETS.container,
    CLAUDECODE: '1', GH_TOKEN: SECRETS.gh, AWS_SECRET_ACCESS_KEY: SECRETS.aws,
  });
});
afterAll(async () => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  provider?.closeAllConnections();
  await new Promise<void>((r) => provider?.close(() => r()));
});

async function runOnce(config: Record<string, unknown>): Promise<Captured[]> {
  captured = [];
  const rig: Rig = makeRig({ config: { anthropicBaseUrl: providerUrl, ...config } });
  try {
    const sid = await rig.start();
    await rig.send({ type: 'prompt', sessionId: sid, text: 'say hi', clientMsgId: 'c1' });
    // the CLI retries 401s a few times, then reports an error result
    await rig.sub.waitFor((m) => m.type === 'sdk' && (m.message as { type?: string }).type === 'result', 60_000).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
  } finally { rig.cleanup(); }
  return captured;
}

function leaks(reqs: Captured[]): string[] {
  const out: string[] = [];
  for (const r of reqs) {
    const blob = JSON.stringify(r.headers) + '\n' + r.body;
    for (const [name, v] of Object.entries(SECRETS)) if (blob.includes(v)) out.push(`${name} in ${r.method} ${r.url}`);
    for (const h of Object.keys(r.headers)) if (/^x-claude-remote|^x-corp|^x-settings|cookie/i.test(h)) out.push(`header ${h} in ${r.method} ${r.url}`);
  }
  return out;
}
const authHeaders = (reqs: Captured[]) => [...new Set(reqs.filter((r) => r.url.includes('/v1/messages')).map((r) => `${r.headers.authorization ?? '-'}|${r.headers['x-api-key'] ?? '-'}`))];

describe.skipIf(!cliInstalled())('CLI credential isolation with a custom endpoint (real CLI, capture provider)', () => {
  it('base URL only: nothing inherited reaches the provider', async () => {
    const reqs = await runOnce({});
    expect(reqs.some((r) => r.url.includes('/v1/messages'))).toBe(true);
    expect(leaks(reqs)).toEqual([]);
    // a non-secret sentinel key (so the CLI never falls back to OAuth / keychain / well-known files)
    expect(authHeaders(reqs)).toEqual(['-|workstation-no-credential']);
  }, 120_000);

  it('base URL only, no apiKeyHelper and no inherited key env: no OAuth fallback (credentials file / well-known files)', async () => {
    const settings = path.join(fakeHome, '.claude', 'settings.json');
    const keep = fs.readFileSync(settings, 'utf8');
    const saved = { a: process.env.ANTHROPIC_API_KEY, b: process.env.ANTHROPIC_AUTH_TOKEN, c: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    fs.writeFileSync(settings, JSON.stringify({ includeCoAuthoredBy: false }));
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      const reqs = await runOnce({});
      expect(reqs.some((r) => r.url.includes('/v1/messages'))).toBe(true);
      expect(leaks(reqs)).toEqual([]);
      expect(authHeaders(reqs)).toEqual(['-|workstation-no-credential']);
    } finally {
      fs.writeFileSync(settings, keep);
      Object.assign(process.env, { ANTHROPIC_API_KEY: saved.a, ANTHROPIC_AUTH_TOKEN: saved.b, CLAUDE_CODE_OAUTH_TOKEN: saved.c });
    }
  }, 120_000);

  it('configured API key: only that key is sent', async () => {
    const reqs = await runOnce({ apiKey: 'sk-configured-key' });
    expect(leaks(reqs)).toEqual([]);
    expect(authHeaders(reqs)).toEqual(['-|sk-configured-key']);
  }, 120_000);

  it('configured auth token: only that bearer is sent', async () => {
    const reqs = await runOnce({ authToken: 'configured-bearer' });
    expect(leaks(reqs)).toEqual([]);
    expect(authHeaders(reqs)).toEqual(['Bearer configured-bearer|-']);
  }, 120_000);

  it('explicit AppConfig env (custom headers) is passed on purpose', async () => {
    const reqs = await runOnce({ apiKey: 'k2', env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Gateway-Team: blue' } });
    expect(leaks(reqs)).toEqual([]);
    expect(reqs.filter((r) => r.url.includes('/v1/messages')).every((r) => r.headers['x-gateway-team'] === 'blue')).toBe(true);
  }, 120_000);
});

void Collector;
