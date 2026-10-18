import { claudeExecutableOption, samePath } from './platform.js';
import type { ModelInfo, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { ModelOption, SlashCommandInfo } from '@workstation/protocol';
import type { ConfigStore } from './config.js';
import type { SessionManager } from './session-manager.js';
import type { QueryHandle, SdkAdapter } from './sdk.js';
import { fetchGatewayModels, gatewayTarget, targetKey } from './gateway.js';

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
  private gateway?: { at: number; key: string; ids: string[] };
  private commands = new Map<string, { at: number; list: SlashCommand[] }>();

  constructor(private adapter: SdkAdapter, private config: ConfigStore, private sessions: SessionManager, private serverCwd: string) {}

  private async withProbe<T>(cwd: string, fn: (q: QueryHandle) => Promise<T>): Promise<T> {
    const q = this.adapter.query({
      prompt: idle as AsyncIterable<never>,
      options: { cwd, settingSources: ['user', 'project', 'local'], env: this.config.cliEnv(), ...claudeExecutableOption() },
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
    const out: ModelOption[] = [];
    // models the configured gateway lists come first: they are the ids that can work there
    for (const id of await this.gatewayModels()) out.push({ id, label: id, description: 'From gateway', source: 'gateway' });
    for (const x of list) {
      if (out.some((o) => o.id === x.value)) continue;
      out.push({
        id: x.value, label: x.displayName, description: x.description,
        ...(x.supportsEffort !== undefined ? { supportsEffort: x.supportsEffort } : {}),
        ...(x.supportedEffortLevels ? { supportedEffortLevels: x.supportedEffortLevels } : {}),
      });
    }
    for (const id of this.config.app.customModels ?? []) if (!out.some((o) => o.id === id)) out.push({ id, label: id, description: 'Custom model' });
    return out;
  }

  /** Ids from GET <base>/v1/models of the configured custom endpoint (cached for a minute; failures cache briefly and stay silent). */
  async gatewayModels(): Promise<string[]> {
    const target = gatewayTarget(this.config.providerEnv());
    if (!target) return [];
    const key = targetKey(target);
    const g = this.gateway;
    if (g && g.key === key && Date.now() - g.at < (g.ids.length ? 60_000 : 15_000)) return g.ids;
    const ids = await fetchGatewayModels(target);
    this.gateway = { at: Date.now(), key, ids };
    return ids;
  }

  async getCommands(cwd: string): Promise<SlashCommandInfo[]> {
    const hit = this.commands.get(cwd);
    let list: SlashCommand[];
    if (hit && Date.now() - hit.at < 60_000) list = hit.list;
    else {
      const live = this.sessions.list().find((s) => samePath(s.cwd, cwd));
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
