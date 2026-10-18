/**
 * Pure logic of the Logs panel (kept free of React and stores so it is unit-tested): filtering, merging streamed entries,
 * the unseen-error badge, follow-the-tail behaviour, time labels and the plain-text form used by Copy / Download.
 */
import type { LogEntry, LogLevel, LogSource } from '@workstation/protocol';

export const CLIENT_CAP = 3000;
/** rows painted at once; "Show earlier" adds another page */
export const PAGE = 300;

export const LEVEL_CHIPS: { level: LogLevel; label: string }[] = [
  { level: 'error', label: 'Errors' }, { level: 'warn', label: 'Warnings' }, { level: 'info', label: 'Info' }, { level: 'debug', label: 'Debug' },
];
export const DEFAULT_LEVELS: LogLevel[] = ['error', 'warn', 'info'];

export interface LogFilters {
  levels: LogLevel[];
  source: LogSource | 'all';
  /** `all`, `auto` (the open session, or all when there is none) or a session id */
  scope: 'all' | 'auto' | (string & {});
  q: string;
}
export const DEFAULT_FILTERS: LogFilters = { levels: DEFAULT_LEVELS, source: 'all', scope: 'auto', q: '' };

/** The session id a scope resolves to: `current` is the open session when it exists on the server (a draft has no log yet). */
export function resolveScope(scope: LogFilters['scope'], current?: string): string | undefined {
  if (scope === 'all') return undefined;
  if (scope === 'auto') return current;
  return scope;
}

const needle = (e: LogEntry) => `${e.source} ${e.message} ${e.detail ? JSON.stringify(e.detail) : ''}`.toLowerCase();

export interface Match { levels?: LogLevel[]; source?: LogSource | 'all'; sessionId?: string; q?: string }
export function matches(e: LogEntry, m: Match): boolean {
  if (m.levels && !m.levels.includes(e.level)) return false;
  if (m.source && m.source !== 'all' && e.source !== m.source) return false;
  if (m.sessionId && e.sessionId !== m.sessionId) return false;
  const q = m.q?.trim().toLowerCase();
  if (q && !needle(e).includes(q)) return false;
  return true;
}
export const filterEntries = (entries: LogEntry[], m: Match): LogEntry[] => entries.filter((e) => matches(e, m));

/** Per-level counts under every filter EXCEPT the level one, so a chip says how many it would add. */
export function countByLevel(entries: LogEntry[], m: Omit<Match, 'levels'>): Record<LogLevel, number> {
  const out: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const e of entries) if (matches(e, m)) out[e.level]++;
  return out;
}

/** Streamed or fetched entries merged into the list: de-duplicated by seq, ordered, capped to the newest `cap`. */
export function mergeEntries(prev: LogEntry[], incoming: LogEntry[], cap = CLIENT_CAP): LogEntry[] {
  if (!incoming.length) return prev;
  const last = prev.length ? prev[prev.length - 1]!.seq : 0;
  let next: LogEntry[];
  if (incoming.every((e, i) => e.seq > last && (i === 0 || e.seq > incoming[i - 1]!.seq))) next = prev.concat(incoming); // the common case: all newer, in order
  else {
    const bySeq = new Map<number, LogEntry>();
    for (const e of prev) bySeq.set(e.seq, e);
    for (const e of incoming) bySeq.set(e.seq, e);
    next = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Errors that arrived after `seenSeq` (what the tab badge counts). */
export const unseenErrors = (entries: LogEntry[], seenSeq: number): number => entries.reduce((n, e) => n + (e.level === 'error' && e.seq > seenSeq ? 1 : 0), 0);

/** Badge text: nothing for 0, the number up to 99, then 99+. */
export const badgeLabel = (n: number): string | undefined => (n <= 0 ? undefined : n > 99 ? '99+' : String(n));

/**
 * Follow-the-tail, as in the conversation: scrolling back near the bottom (within `threshold` px) resumes following,
 * scrolling up stops it, anything else (content growing under a still reader) keeps the current state.
 */
export function followAfterScroll(o: { following: boolean; scrollTop: number; lastTop: number; scrollHeight: number; clientHeight: number; threshold?: number }): { following: boolean; showJump: boolean } {
  const near = o.scrollHeight - o.scrollTop - o.clientHeight < (o.threshold ?? 60);
  const up = o.scrollTop < o.lastTop - 2;
  const following = near ? true : up ? false : o.following;
  return { following, showJump: !following && !near };
}

/** The entry an error banner points at: the closest one of that session (or any, with no session) within `windowMs`, errors and warnings first. */
export function findFocusSeq(entries: LogEntry[], o: { sessionId?: string; ts?: number; windowMs?: number; /** the banner's own text: an entry saying exactly that (the error shown to the user) wins */ text?: string }): number | undefined {
  const pool = o.sessionId ? entries.filter((e) => e.sessionId === o.sessionId) : entries;
  if (!pool.length) return undefined;
  if (o.ts === undefined) { for (let i = pool.length - 1; i >= 0; i--) if (pool[i]!.level === 'error') return pool[i]!.seq; return undefined; }
  const win = o.windowMs ?? 15_000;
  let best: LogEntry | undefined, bestScore = Infinity;
  for (const e of pool) {
    const d = Math.abs(e.ts - o.ts!);
    if (d > win) continue;
    const score = d + (e.level === 'error' ? 0 : e.level === 'warn' ? 2000 : 8000) - (o.text && e.message === o.text ? 1_000_000 : 0);
    if (score < bestScore) { best = e; bestScore = score; }
  }
  return best?.seq;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** `12:04:05` */
export const clock = (ts: number): string => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
/** `2026-10-18 12:04:05.123` (local time) */
export const absoluteTime = (ts: number): string => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(ts)}.${pad(d.getMilliseconds(), 3)}`; };
/** `3 minutes ago` */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}
/** hover text: relative and absolute together */
export const timeTitle = (ts: number, now = Date.now()): string => `${ago(ts, now)} · ${absoluteTime(ts)}`;

/** The same single-line format as the server file / download (so a pasted line looks like the file). */
export function entryText(e: LogEntry): string {
  const sid = e.sessionId ? `[${e.sessionId.slice(0, 8)}] ` : '';
  const d = new Date(e.ts).toISOString();
  return `${d} ${e.level.toUpperCase().padEnd(5)} ${e.source.padEnd(10)} ${sid}${e.message.replace(/\r?\n/g, '\\n')}${e.detail ? ` ${JSON.stringify(e.detail)}` : ''}`;
}
export const entriesText = (entries: LogEntry[]): string => entries.map(entryText).join('\n');

export const shortId = (id: string): string => id.slice(0, 8);

/** `?level=…&source=…` query for the server (list / download) from the panel's filters. */
export function serverQuery(m: Match & { since?: number; limit?: number }): Record<string, string | undefined> {
  return {
    since: m.since !== undefined ? String(m.since) : undefined,
    level: m.levels && m.levels.length && m.levels.length < 4 ? m.levels.join(',') : undefined,
    source: m.source && m.source !== 'all' ? m.source : undefined,
    sessionId: m.sessionId,
    q: m.q?.trim() || undefined,
    limit: m.limit !== undefined ? String(m.limit) : undefined,
  };
}
