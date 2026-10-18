import type { LogsResponse } from '@workstation/protocol';
import { getServerBase, getToken, isDemo } from './storage';

/** REST calls of the Logs panel. Kept out of api.ts: log text is plain text for download and these never run in the demo. */
async function call(method: string, path: string, query: Record<string, string | undefined> = {}): Promise<Response> {
  const url = new URL(path, getServerBase() + '/');
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const token = getToken();
  const res = await fetch(url, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = (await res.json()) as { error?: string }; msg = j.error ?? msg; } catch { /* not json */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res;
}

export const logsApi = {
  list: async (query: Record<string, string | undefined>): Promise<LogsResponse> => {
    if (isDemo()) return { entries: [], lastSeq: 0, total: 0, buffered: 0, capacity: 0 };
    return (await call('GET', '/api/logs', query)).json() as Promise<LogsResponse>;
  },
  /** redacted plain text of everything matching the filters */
  download: async (query: Record<string, string | undefined>): Promise<{ text: string; filename: string }> => {
    const res = await call('GET', '/api/logs/download', query);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'workstation-logs.log';
    return { text: await res.text(), filename: name };
  },
  clear: async (): Promise<{ cleared: number }> => (await call('POST', '/api/logs/clear')).json() as Promise<{ cleared: number }>,
  debugInfo: async (query: Record<string, string | undefined>): Promise<string> => ((await (await call('GET', '/api/logs/debug-info', query)).json()) as { text: string }).text,
};

/** Hands text to the browser as a file download (an <a download> on a blob URL). */
export function saveTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
