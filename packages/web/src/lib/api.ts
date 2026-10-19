import type {
  AppConfig, FsEntry, GatewayTestRequest, GatewayTestResult, GitCommitResult, GitRevertResult, GitStatus, LoadedConfig, ModelOption, PermissionRulesResponse, SessionSummary, SlashCommandInfo,
} from '@workstation/protocol';
import { getServerBase, getToken, isDemo } from './storage';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Q = Record<string, string | undefined>;

async function request<T>(method: string, path: string, query?: Q, body?: unknown): Promise<T> {
  if (isDemo()) {
    const { demoRest } = await import('./demo/server');
    return demoRest<T>(method, path, query ?? {}, body);
  }
  const url = new URL(path, getServerBase() + '/');
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const token = getToken();
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error ?? j.message ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  health: () => request<{ ok: boolean; cwd?: string; version?: string }>('GET', '/api/health'),
  getConfig: () => request<AppConfig>('GET', '/api/config'),
  putConfig: (c: Partial<AppConfig>) => request<AppConfig>('PUT', '/api/config', undefined, c),
  sessions: (cwd?: string) => request<SessionSummary[]>('GET', '/api/sessions', { cwd }),
  messages: (id: string, cwd?: string) => request<{ messages: unknown[] }>('GET', `/api/sessions/${encodeURIComponent(id)}/messages`, { cwd }),
  renameSession: (id: string, title: string) => request<unknown>('PATCH', `/api/sessions/${encodeURIComponent(id)}`, undefined, { title }),
  deleteSession: (id: string) => request<unknown>('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  models: () => request<ModelOption[]>('GET', '/api/models'),
  /** One max_tokens-1 request to the custom endpoint: OK or the provider's own error text (+ the model ids it lists). */
  gatewayTest: (b: GatewayTestRequest) => request<GatewayTestResult>('POST', '/api/gateway/test', undefined, b),
  fsList: async (path?: string): Promise<FsEntry[]> => {
    const r = await request<FsEntry[] | { entries: FsEntry[] }>('GET', '/api/fs/list', { path });
    return Array.isArray(r) ? r : r?.entries ?? [];
  },
  fsRead: (path: string) => request<{ content: string; encoding: string; truncated: boolean }>('GET', '/api/fs/read', { path }),
  searchFiles: (cwd: string, q: string) => request<string[]>('GET', '/api/files/search', { cwd, q }),
  gitStatus: (cwd: string) => request<GitStatus>('GET', '/api/git/status', { cwd }),
  gitDiff: (cwd: string, path?: string) => request<{ diff: string }>('GET', '/api/git/diff', { cwd, path }),
  /** Commits exactly `files` (the changed paths shown in the Changes panel); repository hooks run. */
  gitCommit: (cwd: string, message: string, files: string[]) => request<GitCommitResult>('POST', '/api/git/commit', undefined, { cwd, message, files }),
  gitRevert: (cwd: string, path: string) => request<GitRevertResult>('POST', '/api/git/revert', undefined, { cwd, path }),
  permissionRules: (cwd: string) => request<PermissionRulesResponse>('GET', '/api/permission-rules', { cwd }),
  removePermissionRule: (cwd: string, behavior: string, rule: string) => request<{ removed: boolean }>('DELETE', '/api/permission-rules', undefined, { cwd, behavior, rule }),
  loadedConfig: (sessionId: string) => request<LoadedConfig>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/loaded-config`),
  commands: (cwd?: string) => request<SlashCommandInfo[]>('GET', '/api/commands', { cwd }),
};
