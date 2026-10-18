import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '@workstation/protocol';
import { buildCliEnv, hasCustomEndpoint, prepareCliHome } from './cli-env.js';
import { configDirFor, writeFileAtomic } from './platform.js';
import { log } from './log.js';
import { hostOnly } from './redact.js';

export const MASK = '********';
const SECRET_KEY_RE = /key|token|secret|password|passwd|credential|auth/i;

export interface StoredConfig {
  /** Server auth token (never exposed through the API). */
  token: string;
  app: AppConfig;
}

export function configDir(): string {
  return configDirFor(process.env, process.platform, os.homedir());
}

/** Persisted config (0600) holding the auth token and the user's AppConfig. */
export class ConfigStore {
  private data: StoredConfig;
  readonly file: string;

  constructor(dir = configDir()) {
    this.file = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies on create: tighten a pre-existing dir/file too (MINOR 6)
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours / read-only: best effort */ }
    try { if (fs.existsSync(this.file)) fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
    this.data = this.load();
    const a = this.data.app;
    log.info('config', 'Config loaded', { file: this.file, hasApiKey: !!a.apiKey, hasAuthToken: !!a.authToken, baseUrlHost: hostOnly(a.anthropicBaseUrl), defaultModel: a.defaultModel, customEnvNames: a.env ? Object.keys(a.env) : undefined });
  }

  private load(): StoredConfig {
    let parsed: Partial<StoredConfig> = {};
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredConfig>;
    } catch (e) {
      /* first run or corrupt: regenerate */
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') log.info('config', 'No config file yet: created a new one with a fresh access token', { file: this.file });
      else log.warn('config', `Config file unreadable, a fresh one is created (the access token changes): ${e instanceof Error ? e.message : String(e)}`, { file: this.file });
    }
    const data: StoredConfig = {
      token: typeof parsed.token === 'string' && parsed.token.length >= 16 ? parsed.token : randomBytes(24).toString('base64url'),
      app: parsed.app && typeof parsed.app === 'object' ? parsed.app : {},
    };
    this.data = data;
    if (parsed.token !== data.token) this.save();
    return data;
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2)); // retries Windows EPERM/EBUSY; chmod is a no-op there
  }

  get token(): string { return this.data.token; }
  get app(): AppConfig { return this.data.app; }

  /** Merge a partial AppConfig. Empty-string secrets clear them; masked env values are kept. */
  update(patch: unknown): AppConfig {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('config must be an object');
    const p = patch as Record<string, unknown>;
    const next: AppConfig = { ...this.data.app };
    const str = (k: keyof AppConfig, v: unknown) => {
      if (v === null || v === '') delete (next as Record<string, unknown>)[k];
      else if (typeof v === 'string') (next as Record<string, unknown>)[k] = v.trim();
      else throw new Error(`${String(k)} must be a string`);
    };
    for (const k of ['anthropicBaseUrl', 'apiKey', 'authToken', 'defaultModel'] as const) if (k in p) str(k, p[k]);
    if ('anthropicBaseUrl' in p && next.anthropicBaseUrl && !/^https?:\/\//i.test(next.anthropicBaseUrl)) {
      throw new Error('anthropicBaseUrl must start with http:// or https://');
    }
    if ('defaultEffort' in p) {
      if (p.defaultEffort == null) delete next.defaultEffort;
      else if (['low', 'medium', 'high', 'xhigh', 'max'].includes(p.defaultEffort as string)) next.defaultEffort = p.defaultEffort as AppConfig['defaultEffort'];
      else throw new Error('invalid defaultEffort');
    }
    if ('defaultPermissionMode' in p) {
      if (p.defaultPermissionMode == null) delete next.defaultPermissionMode;
      else if (['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk'].includes(p.defaultPermissionMode as string)) next.defaultPermissionMode = p.defaultPermissionMode as AppConfig['defaultPermissionMode'];
      else throw new Error('invalid defaultPermissionMode');
    }
    if ('permissionTimeoutSec' in p) {
      const v = p.permissionTimeoutSec;
      if (v == null || v === 0) delete next.permissionTimeoutSec;
      else if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 7 * 86400) next.permissionTimeoutSec = v;
      else throw new Error('permissionTimeoutSec must be a positive number of seconds');
    }
    if ('theme' in p) {
      if (p.theme == null) delete next.theme;
      else if (['system', 'light', 'dark'].includes(p.theme as string)) next.theme = p.theme as AppConfig['theme'];
      else throw new Error('invalid theme');
    }
    if ('env' in p) {
      if (p.env == null) delete next.env;
      else if (typeof p.env === 'object' && !Array.isArray(p.env)) {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(p.env as Record<string, unknown>)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env name: ${k}`);
          if (typeof v !== 'string') throw new Error(`env.${k} must be a string`);
          env[k] = v === MASK && this.data.app.env?.[k] !== undefined ? this.data.app.env[k]! : v;
        }
        next.env = env;
      } else throw new Error('env must be an object');
    }
    for (const k of ['customModels', 'recentProjects'] as const) {
      if (k in p) {
        const v = p[k];
        if (v == null) delete next[k];
        else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) next[k] = (v as string[]).slice(0, 200);
        else throw new Error(`${k} must be a string array`);
      }
    }
    delete next.hasApiKey;
    delete next.hasAuthToken;
    this.data.app = next;
    this.save();
    log.info('config', 'Config updated', { fields: Object.keys(p), baseUrlHost: hostOnly(next.anthropicBaseUrl) });
    return next;
  }

  addRecentProject(cwd: string): void {
    const list = [cwd, ...(this.data.app.recentProjects ?? []).filter((p) => p !== cwd)].slice(0, 30);
    this.data.app = { ...this.data.app, recentProjects: list };
    this.save();
  }

  /** AppConfig safe to send to the browser: secrets replaced by has* flags / masks. */
  redacted(): AppConfig {
    const { apiKey, authToken, env, ...rest } = this.data.app;
    const out: AppConfig = { ...rest, hasApiKey: !!apiKey, hasAuthToken: !!authToken };
    if (env) {
      out.env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET_KEY_RE.test(k) && v ? MASK : v]));
    }
    return out;
  }

  /**
   * Full environment for a Claude Code process. With a custom endpoint configured this prepares the isolated
   * CLAUDE_CONFIG_DIR (<config dir>/cli-home) and returns an env without any inherited credential (cli-env.ts).
   */
  cliEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
    const provider = this.providerEnv();
    if (!hasCustomEndpoint(provider)) return buildCliEnv(provider, base);
    return buildCliEnv(provider, base, prepareCliHome(path.join(path.dirname(this.file), 'cli-home')));
  }

  /** Env vars to hand to the Claude Code process. */
  providerEnv(): Record<string, string> {
    const c = this.data.app;
    const env: Record<string, string> = {};
    if (c.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = c.anthropicBaseUrl;
    if (c.apiKey) env.ANTHROPIC_API_KEY = c.apiKey;
    if (c.authToken) env.ANTHROPIC_AUTH_TOKEN = c.authToken;
    return { ...env, ...(c.env ?? {}) };
  }
}
