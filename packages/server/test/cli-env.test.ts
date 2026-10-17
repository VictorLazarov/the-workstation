// M2 unit tests: env allowlist and the isolated CLAUDE_CONFIG_DIR (no real CLI needed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCliEnv, filterSettings, isolatedBaseEnv, NO_CREDENTIAL_SENTINEL, prepareCliHome } from '../src/cli-env.js';
import { ConfigStore } from '../src/config.js';

const inherited = {
  PATH: '/bin', HOME: '/home/u', LANG: 'C.UTF-8', LC_ALL: 'C', TERM: 'xterm', SHELL: '/bin/bash', TMPDIR: '/tmp', JAVA_HOME: '/opt/jdk',
  HTTPS_PROXY: 'http://proxy:3128', HTTP_PROXY: 'http://user:pw@proxy:3128', NO_PROXY: 'localhost',
  ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', ANTHROPIC_CUSTOM_HEADERS: 'X-A: s', ANTHROPIC_BASE_URL: 'https://inherited',
  CLAUDE_CODE_OAUTH_TOKEN: 'c', CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'd', CLAUDE_CODE_CONTAINER_ID: 'e', CLAUDECODE: '1',
  CLAUDE_CONFIG_DIR: '/home/u/.claude', CCR_X: 'f', SESSION_INGRESS_URL: 'g', CLAUDE_SESSION_INGRESS_TOKEN_FILE: 'h', WORKSTATION_TOKEN: 'i',
  GH_TOKEN: 'j', GITHUB_TOKEN: 'k', AWS_SECRET_ACCESS_KEY: 'l', CLOUDSDK_AUTH_ACCESS_TOKEN: 'm', OTEL_EXPORTER_OTLP_HEADERS: 'n',
  GIT_CONFIG_VALUE_0: 'Authorization: Bearer o', npm_config__authToken: 'p', DB_URL: 'postgres://u:pw@db/x', MY_PASSWORD: 'q',
};

describe('isolated env (custom endpoint)', () => {
  it('keeps the allowlist and toolchain vars, drops every inherited credential', () => {
    const env = isolatedBaseEnv(inherited);
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/u', LANG: 'C.UTF-8', LC_ALL: 'C', TERM: 'xterm', SHELL: '/bin/bash', TMPDIR: '/tmp', JAVA_HOME: '/opt/jdk', HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost' });
    for (const k of Object.keys(inherited)) if (!(k in env)) expect(['HTTP_PROXY'].includes(k) || !['PATH', 'HOME'].includes(k)).toBe(true);
    const dropped = Object.keys(inherited).filter((k) => !(k in env)).sort();
    expect(dropped).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'AWS_SECRET_ACCESS_KEY', 'CCR_X', 'CLAUDECODE', 'CLAUDE_CODE_CONTAINER_ID',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'DB_URL',
      'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_VALUE_0', 'HTTP_PROXY', 'MY_PASSWORD', 'OTEL_EXPORTER_OTLP_HEADERS', 'SESSION_INGRESS_URL', 'WORKSTATION_TOKEN', 'npm_config__authToken'].sort());
  });
  it('strict mode keeps only the base allowlist', () => {
    expect(Object.keys(isolatedBaseEnv(inherited, true)).sort()).toEqual(['HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'NO_PROXY', 'PATH', 'SHELL', 'TERM', 'TMPDIR']);
  });
  it('configured values win; sentinel only without key/token; default path is untouched', () => {
    expect(buildCliEnv({ ANTHROPIC_BASE_URL: 'http://gw' }, inherited, '/x/cli-home')).toMatchObject({ ANTHROPIC_BASE_URL: 'http://gw', ANTHROPIC_API_KEY: NO_CREDENTIAL_SENTINEL, CLAUDE_CONFIG_DIR: '/x/cli-home' });
    const tok = buildCliEnv({ ANTHROPIC_BASE_URL: 'http://gw', ANTHROPIC_AUTH_TOKEN: 't' }, inherited, '/x');
    expect(tok.ANTHROPIC_AUTH_TOKEN).toBe('t');
    expect(tok.ANTHROPIC_API_KEY).toBeUndefined();
    expect(tok.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(buildCliEnv({ ANTHROPIC_BASE_URL: 'http://gw', ANTHROPIC_CUSTOM_HEADERS: 'X-T: 1' }, inherited).ANTHROPIC_CUSTOM_HEADERS).toBe('X-T: 1');
    const normal = buildCliEnv({}, inherited);
    expect(normal).toMatchObject(inherited);
    expect(normal.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
  });
});

describe('isolated CLAUDE_CONFIG_DIR', () => {
  function userDir() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-clihome-'));
    const src = path.join(home, '.claude');
    fs.mkdirSync(path.join(src, 'skills/x'), { recursive: true });
    fs.mkdirSync(path.join(src, 'agents'));
    fs.mkdirSync(path.join(src, 'remote'));
    fs.writeFileSync(path.join(src, 'remote/.oauth_token'), 'secret');
    fs.writeFileSync(path.join(src, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret"}}');
    fs.writeFileSync(path.join(src, 'api_key_backup.txt'), 'secret');
    fs.writeFileSync(path.join(src, 'CLAUDE.md'), 'memory');
    fs.writeFileSync(path.join(src, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo k', otelHeadersHelper: 'x', awsAuthRefresh: 'y', model: 'opus', hooks: { Stop: [] }, env: { ANTHROPIC_CUSTOM_HEADERS: 'X: s', FOO_TOKEN: 's', BAR: 'ok' } }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ primaryApiKey: 'secret', oauthAccount: { a: 1 }, mcpServers: { m: { command: 'x' } }, projects: { '/p': { mcpServers: { n: {} }, history: ['secret prompt'] } } }));
    return { home, src };
  }
  it('links non-credential config, filters settings, never contains credential files', () => {
    const { home, src } = userDir();
    const dir = path.join(home, 'ws', 'cli-home');
    prepareCliHome(dir, src, path.join(home, '.claude.json'));
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual(['.claude.json', 'CLAUDE.md', 'agents', 'file-history', 'projects', 'settings.json', 'skills'].sort());
    expect(fs.readlinkSync(path.join(dir, 'skills'))).toBe(fs.realpathSync(path.join(src, 'skills')));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(settings).toEqual({ model: 'opus', hooks: { Stop: [] }, env: { BAR: 'ok' } });
    const g = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    expect(g).toEqual({ mcpServers: { m: { command: 'x' } }, projects: { '/p': { mcpServers: { n: {} } } }, hasCompletedOnboarding: true });
    expect(JSON.stringify(g)).not.toContain('secret');
    // something wrote credentials into the isolated dir: removed on the next launch
    fs.writeFileSync(path.join(dir, '.credentials.json'), 'x');
    fs.mkdirSync(path.join(dir, 'remote'));
    prepareCliHome(dir, src, path.join(home, '.claude.json'));
    expect(fs.existsSync(path.join(dir, '.credentials.json')) || fs.existsSync(path.join(dir, 'remote'))).toBe(false);
  });
  it('filterSettings drops credential helpers and credential env', () => {
    expect(filterSettings({ apiKeyHelper: 'x', gcpAuthRefresh: 'y', env: { HTTPS_PROXY: 'http://u:p@h', PATHX: 'ok' } })).toEqual({ env: { PATHX: 'ok' } });
  });
  it('ConfigStore.cliEnv isolates only with a custom endpoint', () => {
    const { home } = userDir();
    const prev = { HOME: process.env.HOME, CCD: process.env.CLAUDE_CONFIG_DIR };
    process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const store = new ConfigStore(path.join(home, 'ws'));
      expect(store.cliEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'inh' }).CLAUDE_CONFIG_DIR).toBeUndefined();
      store.update({ anthropicBaseUrl: 'http://gw' });
      const env = store.cliEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'inh' });
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, 'ws', 'cli-home'));
      expect(env.ANTHROPIC_API_KEY).toBe(NO_CREDENTIAL_SENTINEL);
      expect(fs.existsSync(path.join(home, 'ws', 'cli-home', 'skills'))).toBe(true);
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.CCD) process.env.CLAUDE_CONFIG_DIR = prev.CCD;
    }
  });
});
