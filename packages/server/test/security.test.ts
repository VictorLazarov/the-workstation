import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config.js';
import { isHostAllowed, isOriginAllowed, tokenMatches } from '../src/security.js';
import { api, connect, makeServer, raw, type TestServer } from './helpers.js';

describe('security primitives', () => {
  const o = { host: '127.0.0.1', allowedOrigins: ['https://ok.example'], allowedHosts: [] };
  it('host allowlist', () => {
    expect(isHostAllowed('localhost:7777', o)).toBe(true);
    expect(isHostAllowed('127.0.0.1:1', o)).toBe(true);
    expect(isHostAllowed('[::1]:7777', o)).toBe(true);
    expect(isHostAllowed('evil.example:7777', o)).toBe(false);
    expect(isHostAllowed('192.168.1.5:7777', o)).toBe(false);
    expect(isHostAllowed('', o)).toBe(false);
    expect(isHostAllowed(undefined, o)).toBe(false);
    expect(isHostAllowed('localhost@evil.com', o)).toBe(false);
    expect(isHostAllowed('192.168.1.5:7777', { host: '0.0.0.0' })).toBe(true);
    expect(isHostAllowed('evil.example', { host: '0.0.0.0' })).toBe(false);
    expect(isHostAllowed('box.lan', { host: 'box.lan' })).toBe(true);
  });
  it('origin allowlist', () => {
    expect(isOriginAllowed(undefined, 'localhost', o)).toBe(true);
    // MINOR 1: same-origin only (host AND port), or explicitly allowlisted
    expect(isOriginAllowed('http://localhost:7777', 'localhost:7777', o)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:7777', '127.0.0.1:7777', o)).toBe(true);
    expect(isOriginAllowed('http://localhost', 'localhost:80', o)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', 'localhost:7777', o)).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', 'localhost:7777', o)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:7777', 'localhost:7777', o)).toBe(false);
    expect(isOriginAllowed('http://localhost:7777', 'evil.example:7777', o)).toBe(false);
    expect(isOriginAllowed('http://localhost:5173', 'localhost:7777', { ...o, allowedOrigins: ['http://localhost:5173'] })).toBe(true);
    expect(isOriginAllowed('http://evil.example', 'localhost:7777', o)).toBe(false);
    expect(isOriginAllowed('null', 'localhost:7777', o)).toBe(false);
    expect(isOriginAllowed('https://ok.example', 'localhost:7777', o)).toBe(true);
    expect(isOriginAllowed('file://x', 'localhost:7777', o)).toBe(false);
  });
  it('constant-time token compare semantics', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('', 'abc')).toBe(false);
    expect(tokenMatches(null, 'abc')).toBe(false);
  });
});

describe('http/ws guards', () => {
  let s: TestServer;
  beforeAll(async () => { s = await makeServer(); });
  afterAll(async () => { await s.close(); });

  it('requires bearer token on /api', async () => {
    expect((await api(s, '/api/health', {}, null)).status).toBe(401);
    expect((await api(s, '/api/health', {}, 'wrong-token')).status).toBe(401);
    expect((await fetch(`${s.base}/api/health?token=${s.token}`)).status).toBe(401); // query token not accepted for REST
    expect((await api(s, '/api/health')).status).toBe(200);
  });
  it('rejects forged Host (DNS rebinding)', async () => {
    const r = await raw(s, '/api/health', { host: 'evil.example:7777', authorization: `Bearer ${s.token}` });
    expect(r.status).toBe(403);
  });
  it('rejects cross-site Origin even with token', async () => {
    const r = await raw(s, '/api/health', { host: `127.0.0.1:${s.port}`, origin: 'http://evil.example', authorization: `Bearer ${s.token}` });
    expect(r.status).toBe(403);
    const ok = await raw(s, '/api/health', { host: `localhost:${s.port}`, origin: `http://localhost:${s.port}`, authorization: `Bearer ${s.token}` });
    expect(ok.status).toBe(200);
    const otherPort = await raw(s, '/api/health', { host: `localhost:${s.port}`, origin: 'http://localhost:3000', authorization: `Bearer ${s.token}` });
    expect(otherPort.status).toBe(403);
  });
  it('websocket needs token, good origin and host', async () => {
    await expect(connect(s, { token: null })).rejects.toThrow(/401/);
    await expect(connect(s, { token: 'nope' })).rejects.toThrow(/401/);
    await expect(connect(s, { origin: 'http://evil.example' })).rejects.toThrow(/403/);
    await expect(connect(s, { origin: 'http://localhost:3000' })).rejects.toThrow(/403/);
    const c = await connect(s, { origin: `http://127.0.0.1:${s.port}` });
    const hello = await c.waitFor((m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', mock: true });
    c.close();
  });
  it('config file is 0600 and has a token', () => {
    const st = fs.statSync(s.config.file);
    expect(st.mode & 0o777).toBe(0o600);
    expect(s.token.length).toBeGreaterThanOrEqual(24);
  });
  it('a pre-existing world-readable config dir/file is tightened on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-perm-'));
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token: 'x'.repeat(32), app: {} }), { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'config.json'), 0o644);
    new ConfigStore(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o777).toBe(0o600);
  });
});
