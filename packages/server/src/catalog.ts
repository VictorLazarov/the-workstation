import type { ModelInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { ModelOption, SlashCommandInfo } from '@workstation/protocol';
import type { ConfigStore } from './config.js';
import type { SessionManager } from './session-manager.js';
import { buildCliEnv, type QueryHandle, type SdkAdapter } from './sdk.js';

const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default', description: 'Recommended model for your account' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Latest Sonnet' },
  { value: 'opus', displayName: 'Opus', description: 'Latest Opus' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest model' },
];

const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}), return: async () => ({ done: true as const, value: undefined }) }) };

/** Models and slash commands, fetched from a throwaway (or live) query and cached. */
export class Catalog {
  private models?: { at: number; key: string; list: ModelInfo[]; fallback: boolean };
  private commands = new Map<string, { at: number; list: SlashCommand[] }>();

  constructor(private adapter: SdkAdapter, private config: ConfigStore, private sessions: SessionManager, private serverCwd: string) {}

  private async withProbe<T>(cwd: string, fn: (q: QueryHandle) => Promise<T>): Promise<T> {
    const q = this.adapter.query({
      prompt: idle as AsyncIterable<never>,
      options: { cwd, settingSources: ['user', 'project', 'local'], env: buildCliEnv(this.config.providerEnv()) },
    });
    try {
      return await Promise.race([fn(q), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 25_000))]);
    } finally {
      try { q.close(); } catch { /* ignore */ }
    }
  }

  async getModels(): Promise<ModelOption[]> {
    const key = JSON.stringify([this.config.app.anthropicBaseUrl, !!this.config.app.apiKey, !!this.config.app.authToken]);
    const m = this.models;
    let list: ModelInfo[];
    if (m && m.key === key && Date.now() - m.at < (m.fallback ? 30_000 : 10 * 60_000)) list = m.list;
    else {
      try {
        const live = this.sessions.list()[0];
        list = live ? await live.query.supportedModels() : await this.withProbe(this.serverCwd, (q) => q.supportedModels());
        this.models = { at: Date.now(), key, list, fallback: false };
      } catch {
        list = FALLBACK_MODELS;
        this.models = { at: Date.now(), key, list, fallback: true };
      }
    }
    const out: ModelOption[] = list.map((x) => ({
      id: x.value, label: x.displayName, description: x.description,
      ...(x.supportsEffort !== undefined ? { supportsEffort: x.supportsEffort } : {}),
      ...(x.supportedEffortLevels ? { supportedEffortLevels: x.supportedEffortLevels } : {}),
    }));
    for (const id of this.config.app.customModels ?? []) if (!out.some((o) => o.id === id)) out.push({ id, label: id, description: 'Custom model' });
    return out;
  }

  async getCommands(cwd: string): Promise<SlashCommandInfo[]> {
    const hit = this.commands.get(cwd);
    let list: SlashCommand[];
    if (hit && Date.now() - hit.at < 60_000) list = hit.list;
    else {
      const live = this.sessions.list().find((s) => s.cwd === cwd);
      try {
        list = live ? await live.query.supportedCommands() : await this.withProbe(cwd, (q) => q.supportedCommands());
        this.commands.set(cwd, { at: Date.now(), list });
      } catch {
        list = [];
      }
    }
    return list.map((c) => ({ name: c.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }));
  }
}
