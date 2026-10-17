/**
 * Credential isolation for the Claude Code CLI when the user configured a custom endpoint / key / token
 * (docs/ARCHITECTURE.md "Credential isolation"; scrutiniser pass 1, M2).
 *
 * Without a custom endpoint the CLI runs exactly as the user's own `claude` would (inherited env, ~/.claude, normal login).
 *
 * With one, nothing the server inherited may be used as a credential or sent to that endpoint:
 *  1. Environment: an ALLOWLIST for everything the CLI itself interprets. Every ANTHROPIC_* / CLAUDE* / CCR_* /
 *     SESSION_INGRESS* / cloud-provider / OTEL_* / WORKSTATION_* variable is dropped, as is any variable whose name looks
 *     like a credential (KEY, TOKEN, SECRET, PASSWORD, AUTH, COOKIE, SESSION, CREDENTIAL…) and any proxy whose URL carries
 *     user:password. Ordinary toolchain variables (JAVA_HOME, GOPATH, VIRTUAL_ENV…) are kept so the agent's tools still
 *     work; WORKSTATION_CLI_ENV=strict keeps only the base allowlist. Then the AppConfig values are added on purpose.
 *  2. Config dir: CLAUDE_CONFIG_DIR=<workstation config>/cli-home. It links the user's non-credential config (CLAUDE.md,
 *     skills, agents, commands, output styles, plugins, plus session transcripts/file history so the session list and
 *     rewind keep working), a FILTERED copy of settings.json (no apiKeyHelper / auth refresh / OTEL header helpers, no
 *     credential env) and only the MCP/onboarding keys of .claude.json. Credential files (.credentials.json, remote/,
 *     anything *token*, *credential*, *key*) never appear there (and are deleted if something put them there). A
 *     separate CLAUDE_CONFIG_DIR also selects a separate macOS keychain entry, which is empty.
 *  3. The CLI also reads hard-coded well-known credential files (e.g. /home/claude/.claude/remote/.oauth_token in Claude
 *     Code containers) when it has no explicit credential, independent of HOME and CLAUDE_CONFIG_DIR. So when neither
 *     an API key nor an auth token is configured, a NON-SECRET sentinel API key is set: the CLI then never falls back to
 *     OAuth, the keychain or those files, and the endpoint sees `x-api-key: workstation-no-credential`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NO_CREDENTIAL_SENTINEL = 'workstation-no-credential';

const BASE_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'EDITOR', 'VISUAL', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
]);
const PROXY_VARS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);
/** Namespaces the CLI (or its auth/telemetry plugins) interprets: never inherited. */
const DENY_PREFIX = /^(ANTHROPIC_|CLAUDE|CCR_|SESSION_INGRESS|WORKSTATION_|AWS_|AZURE_|GOOGLE_|GCLOUD|GCP_|CLOUDSDK_|CLOUD_ML_|VERTEX|BEDROCK|FOUNDRY|OTEL_|MCP_|NPM_CONFIG_|YARN_|GIT_CONFIG_|GIT_ASKPASS|SSH_ASKPASS|DOCKER_|GLOBAL_AGENT_|ELECTRON_|DISABLE_|MAX_THINKING|API_TIMEOUT)/i;
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASS(WORD|WD)?\b|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|SIGNATURE|CERT_PASS/i;
const hasUserinfo = (v: string) => /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i.test(v.trim());

/** True when the user configured their own provider (base URL / API key / auth token, in AppConfig or AppConfig.env). */
export function hasCustomEndpoint(providerEnv: Record<string, string>): boolean {
  return ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some((k) => !!providerEnv[k]);
}

/** Inherited variables allowed through to the CLI in isolated mode. */
export function isolatedBaseEnv(base: NodeJS.ProcessEnv = process.env, strict = base.WORKSTATION_CLI_ENV === 'strict'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (PROXY_VARS.has(k)) { if (!hasUserinfo(v)) out[k] = v; continue; }
    if (BASE_ALLOW.has(k) || /^LC_[A-Z_]+$/.test(k)) { out[k] = v; continue; }
    if (strict) continue;
    if (DENY_PREFIX.test(k) || CREDENTIAL_NAME.test(k) || /proxy/i.test(k) || hasUserinfo(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Entries of the user's Claude config dir that are linked into the isolated one (no credentials among them). */
const LINKED = ['CLAUDE.md', 'skills', 'agents', 'commands', 'output-styles', 'plugins', 'projects', 'file-history', 'todos', 'plans', 'keybindings.json'];
/** Entries created so the CLI writes transcripts where the server (and the user's own `claude`) read them. */
const ENSURE_DIRS = ['projects', 'file-history'];
const CREDENTIAL_FILE = /credential|token|oauth|secret|api[-_]?key|\.key$|^remote$|keychain/i;
const SETTINGS_DROP = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'forceLoginMethod', 'forceLoginOrgUUID'];
const GLOBAL_KEEP = ['mcpServers', 'hasCompletedOnboarding', 'theme'];
const PROJECT_KEEP = ['mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'hasTrustDialogAccepted', 'allowedTools'];

export function userClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function userGlobalConfig(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}
const readJson = (f: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};
const writePrivate = (f: string, data: unknown) => {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
};
const isCredentialEnvName = (k: string) => DENY_PREFIX.test(k) || CREDENTIAL_NAME.test(k) || /proxy/i.test(k);

/** settings.json without credential helpers or credential env. */
export function filterSettings(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s };
  for (const k of SETTINGS_DROP) delete out[k];
  if (out.env && typeof out.env === 'object' && !Array.isArray(out.env)) {
    out.env = Object.fromEntries(Object.entries(out.env as Record<string, unknown>).filter(([k, v]) => !isCredentialEnvName(k) && !(typeof v === 'string' && hasUserinfo(v))));
  }
  return out;
}

/**
 * Creates/refreshes the isolated CLAUDE_CONFIG_DIR at `dir` from the user's config (`src`, `globalSrc`). Idempotent;
 * called before every CLI launch so changes to the user's settings show up. Returns `dir`.
 */
export function prepareCliHome(dir: string, src = userClaudeDir(), globalSrc = userGlobalConfig()): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const realDir = fs.realpathSync(dir);
  let realSrc: string | null = null;
  try { realSrc = fs.realpathSync(src); } catch { /* user has no ~/.claude yet */ }
  if (realSrc === realDir) throw new Error('isolated CLI config dir must differ from the user config dir');
  // credentials never live here (drop anything credential-like that appeared, e.g. from a login attempt)
  for (const name of fs.readdirSync(dir)) {
    if (CREDENTIAL_FILE.test(name) || name === '.credentials.json') fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  if (realSrc) {
    for (const name of ENSURE_DIRS) { try { fs.mkdirSync(path.join(realSrc, name), { recursive: true }); } catch { /* read-only home */ } }
    for (const name of LINKED) {
      const from = path.join(realSrc, name);
      const to = path.join(dir, name);
      if (!fs.existsSync(from)) continue;
      const cur = fs.lstatSync(to, { throwIfNoEntry: false });
      if (cur?.isSymbolicLink()) { if (fs.readlinkSync(to) === from) continue; fs.rmSync(to, { force: true }); }
      else if (cur) continue; // a real file/dir the CLI created before the user's existed: leave it
      try { fs.symlinkSync(from, to); } catch { /* e.g. Windows without symlink rights: feature degrades, no leak */ }
    }
  }
  const settings = realSrc ? readJson(path.join(realSrc, 'settings.json')) : null;
  writePrivate(path.join(dir, 'settings.json'), filterSettings(settings ?? {}));
  // .claude.json: keep the CLI's own isolated state, refresh only MCP/onboarding keys from the user's file
  const target = path.join(dir, '.claude.json');
  const mine = readJson(target) ?? {};
  for (const k of Object.keys(mine)) if (/key|token|oauth|account|credential|secret/i.test(k)) delete mine[k];
  const theirs = readJson(globalSrc) ?? {};
  for (const k of GLOBAL_KEEP) if (k in theirs) mine[k] = theirs[k];
  if (theirs.projects && typeof theirs.projects === 'object') {
    const projects: Record<string, unknown> = {};
    for (const [p, v] of Object.entries(theirs.projects as Record<string, Record<string, unknown>>)) {
      if (!v || typeof v !== 'object') continue;
      projects[p] = Object.fromEntries(PROJECT_KEEP.filter((k) => k in v).map((k) => [k, v[k]]));
    }
    mine.projects = projects;
  }
  mine.hasCompletedOnboarding = true;
  writePrivate(target, mine);
  return dir;
}

/**
 * Environment for a Claude Code process. `providerEnv` comes from AppConfig (base URL, key, token, explicit env);
 * `cliHome` is the isolated CLAUDE_CONFIG_DIR to use when a custom endpoint is configured.
 */
export function buildCliEnv(providerEnv: Record<string, string>, base: NodeJS.ProcessEnv = process.env, cliHome?: string): Record<string, string | undefined> {
  const extra = { CLAUDE_AGENT_SDK_CLIENT_APP: 'the-workstation/0.1.0' };
  if (!hasCustomEndpoint(providerEnv)) return { ...base, ...extra, ...providerEnv };
  const env: Record<string, string | undefined> = { ...isolatedBaseEnv(base), ...extra };
  if (cliHome) env.CLAUDE_CONFIG_DIR = cliHome;
  Object.assign(env, providerEnv);
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_API_KEY = NO_CREDENTIAL_SENTINEL;
  return env;
}
