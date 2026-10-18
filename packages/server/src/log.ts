/**
 * Structured diagnostics log.
 *
 *  - every entry is {seq, ts, level, source, sessionId?, message, detail?} and is REDACTED when it is written (redact.ts),
 *    so the ring buffer, the file, the REST answers and the WebSocket stream can never hold a key or token;
 *  - an in-memory ring buffer (default 5000 entries) serves the Logs panel;
 *  - entries at `info` and above are also appended to a rotating file `<config dir>/logs/server.log` (0600, ~5 MB, 3 rotated
 *    copies) that survives restarts: `tail -f` it in a container (docs/DEVCONTAINER.md);
 *  - prompts and file contents are never logged: callers pass counts, names and ids, never text.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry, LogLevel, LogSource, LogsResponse } from '@workstation/protocol';
import { LOG_LEVELS } from '@workstation/protocol';
import { renameWithRetry } from './platform.js';
import { redactString, redactValue } from './redact.js';

export type { LogEntry, LogLevel, LogSource };

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const DEFAULT_CAPACITY = 5000;
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP_FILES = 3;
const MAX_MESSAGE = 2000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Fixed-size circular buffer: pushing past capacity drops the oldest item. */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private start = 0;
  private count = 0;
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
    this.items = new Array<T | undefined>(capacity);
  }
  get size() { return this.count; }
  push(item: T): void {
    if (this.count < this.capacity) this.items[(this.start + this.count++) % this.capacity] = item;
    else { this.items[this.start] = item; this.start = (this.start + 1) % this.capacity; }
  }
  /** oldest first */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }
  clear(): number {
    const n = this.count;
    this.items = new Array<T | undefined>(this.capacity);
    this.start = 0; this.count = 0;
    return n;
  }
}

export interface LogFilter {
  /** only entries with seq greater than this */
  since?: number;
  /** exact levels to keep (empty / undefined = all) */
  levels?: LogLevel[];
  sources?: LogSource[];
  sessionId?: string;
  /** case-insensitive substring over source, message and detail */
  q?: string;
  /** newest N matches (default 500, max 5000) */
  limit?: number;
}

const isLevel = (v: string): v is LogLevel => (LOG_LEVELS as readonly string[]).includes(v);
const list = (v: string | null | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Parses `?since=&level=&source=&sessionId=&q=&limit=` (comma-separated lists; unknown levels are ignored). */
export function parseLogFilter(p: { get(k: string): string | null }): LogFilter {
  const since = Number(p.get('since'));
  const limit = Number(p.get('limit'));
  const levels = list(p.get('level')).filter(isLevel);
  const sources = list(p.get('source')) as LogSource[];
  const q = p.get('q')?.slice(0, 200);
  const sessionId = p.get('sessionId') ?? undefined;
  return {
    ...(Number.isFinite(since) && p.get('since') ? { since } : {}),
    ...(levels.length ? { levels } : {}),
    ...(sources.length ? { sources } : {}),
    ...(sessionId ? { sessionId: sessionId.slice(0, 100) } : {}),
    ...(q ? { q } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(5000, Math.floor(limit)) } : {}),
  };
}

const hay = new WeakMap<LogEntry, string>();
function haystack(e: LogEntry): string {
  let h = hay.get(e);
  if (h === undefined) {
    h = `${e.source} ${e.level} ${e.message} ${e.detail ? JSON.stringify(e.detail) : ''}`.toLowerCase();
    hay.set(e, h);
  }
  return h;
}

export function matchesFilter(e: LogEntry, f: LogFilter): boolean {
  if (f.since !== undefined && e.seq <= f.since) return false;
  if (f.levels?.length && !f.levels.includes(e.level)) return false;
  if (f.sources?.length && !f.sources.includes(e.source)) return false;
  if (f.sessionId && e.sessionId !== f.sessionId) return false;
  if (f.q && !haystack(e).includes(f.q.toLowerCase())) return false;
  return true;
}

/** `2026-10-18T12:00:00.123Z ERROR sdk        [3f2a9c1e] message {"detail":1}`: one line per entry (the file and the download). */
export function formatEntry(e: LogEntry): string {
  const sid = e.sessionId ? `[${e.sessionId.slice(0, 8)}] ` : '';
  const msg = e.message.replace(/\r?\n/g, '\\n');
  const detail = e.detail ? ` ${JSON.stringify(e.detail)}` : '';
  return `${new Date(e.ts).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.source.padEnd(10)} ${sid}${msg}${detail}`;
}

/** Size-capped file with numbered rotation (`server.log` -> `.1` -> `.2` -> `.3`). Synchronous: the entries are small and rare. */
export class RotatingFile {
  private size = 0;
  private failures = 0;
  lastError?: string;
  constructor(readonly file: string, private maxBytes = DEFAULT_MAX_FILE_BYTES, private keep = DEFAULT_KEEP_FILES) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { this.size = fs.statSync(file).size; fs.chmodSync(file, 0o600); } catch { this.size = 0; }
  }
  get ok() { return this.failures < 5; }
  write(line: string): void {
    if (!this.ok) return;
    const data = line.endsWith('\n') ? line : `${line}\n`;
    const bytes = Buffer.byteLength(data);
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, data, { mode: 0o600 });
      this.size += bytes;
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }
  /** `server.log.3` is deleted, `.2` -> `.3`, `.1` -> `.2`, `server.log` -> `.1`. */
  rotate(): void {
    const n = (i: number) => `${this.file}.${i}`;
    try { fs.rmSync(n(this.keep), { force: true }); } catch { /* best effort */ }
    for (let i = this.keep - 1; i >= 1; i--) {
      try { if (fs.existsSync(n(i))) renameWithRetry(n(i), n(i + 1)); } catch { /* best effort */ }
    }
    try { renameWithRetry(this.file, n(1)); } catch { try { fs.rmSync(this.file, { force: true }); } catch { /* best effort */ } }
    this.size = 0;
  }
}

export interface LoggerOptions {
  capacity?: number;
  now?: () => number;
  /** lowest level written to the file (the ring buffer keeps everything); default `info` or WORKSTATION_LOG_LEVEL */
  fileLevel?: LogLevel;
  /** copy errors to stderr (the terminal the server runs in); default on, off under vitest */
  stderr?: boolean;
}

export class Logger {
  private ring: RingBuffer<LogEntry>;
  private seq = 0;
  private file: RotatingFile | null = null;
  private fileSeq = 0;
  private listeners = new Set<(e: LogEntry) => void>();
  private secrets: () => Iterable<string> = () => [];
  private now: () => number;
  private fileLevel: LogLevel;
  private stderr: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.ring = new RingBuffer(opts.capacity ?? DEFAULT_CAPACITY);
    this.now = opts.now ?? Date.now;
    const env = process.env.WORKSTATION_LOG_LEVEL?.toLowerCase();
    this.fileLevel = opts.fileLevel ?? (env && isLevel(env) ? env : 'info');
    this.stderr = opts.stderr ?? (process.env.WORKSTATION_LOG_STDERR !== '0' && !process.env.VITEST);
  }

  get capacity() { return this.ring.capacity; }
  get size() { return this.ring.size; }
  get lastSeq() { return this.seq; }
  get filePath(): string | undefined { return this.file?.ok ? this.file.file : undefined; }
  get fileError(): string | undefined { return this.file?.lastError; }

  /** Exact secret values (access token, API keys, secret-named env values) that are removed wherever they appear. */
  setSecrets(provider: () => Iterable<string>): void { this.secrets = provider; }

  /** Start appending to `file` (and write what the buffer already holds, e.g. the config-load entries from before the sink existed). */
  attachFile(file: string, opts: { maxBytes?: number; keep?: number } = {}): string | undefined {
    try {
      const f = new RotatingFile(file, opts.maxBytes, opts.keep);
      const backlog = this.ring.toArray().filter((e) => e.seq > this.fileSeq && RANK[e.level] >= RANK[this.fileLevel]);
      this.file = f;
      for (const e of backlog) f.write(formatEntry(e));
      this.fileSeq = this.seq;
      return file;
    } catch (e) {
      this.file = null;
      this.warn('server', 'Could not open the log file; logs stay in memory only', { file, error: e });
      return undefined;
    }
  }
  detachFile(): void { this.file = null; }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  log(level: LogLevel, source: LogSource, message: string, detail?: unknown, sessionId?: string): LogEntry {
    const opts = { secrets: this.secrets() };
    const clean = redactValue(detail, opts);
    const d = clean && typeof clean === 'object' && !Array.isArray(clean) ? (clean as Record<string, unknown>) : clean === undefined ? undefined : { value: clean };
    // a session id can come straight from a client message: only a plain id that survives redaction is kept
    const sid = sessionId && SAFE_ID.test(sessionId) && redactString(sessionId, opts) === sessionId ? sessionId : undefined;
    const entry: LogEntry = {
      seq: ++this.seq, ts: this.now(), level, source,
      ...(sid ? { sessionId: sid } : {}),
      message: redactString(String(message), { ...opts, maxString: MAX_MESSAGE }),
      ...(d && Object.keys(d).length ? { detail: d } : {}),
    };
    this.ring.push(entry);
    if (this.file && RANK[level] >= RANK[this.fileLevel]) { this.file.write(formatEntry(entry)); this.fileSeq = entry.seq; }
    if (this.stderr && (level === 'error' || (level === 'warn' && source !== 'http'))) {
      try { process.stderr.write(`[workstation] ${formatEntry(entry)}\n`); } catch { /* closed stderr */ }
    }
    for (const fn of this.listeners) { try { fn(entry); } catch { /* a dead socket must not break logging */ } }
    return entry;
  }
  debug(source: LogSource, message: string, detail?: unknown, sessionId?: string) { return this.log('debug', source, message, detail, sessionId); }
  info(source: LogSource, message: string, detail?: unknown, sessionId?: string) { return this.log('info', source, message, detail, sessionId); }
  warn(source: LogSource, message: string, detail?: unknown, sessionId?: string) { return this.log('warn', source, message, detail, sessionId); }
  error(source: LogSource, message: string, detail?: unknown, sessionId?: string) { return this.log('error', source, message, detail, sessionId); }

  /** Entries matching `f` (oldest first); `limit` keeps the newest N. */
  entries(f: LogFilter = {}): { entries: LogEntry[]; total: number } {
    const all = this.ring.toArray().filter((e) => matchesFilter(e, f));
    const limit = Math.min(5000, Math.max(1, f.limit ?? 500));
    return { entries: all.length > limit ? all.slice(all.length - limit) : all, total: all.length };
  }

  query(f: LogFilter = {}): LogsResponse {
    const { entries, total } = this.entries(f);
    return { entries, lastSeq: this.seq, total, buffered: this.ring.size, capacity: this.ring.capacity, ...(this.filePath ? { file: this.filePath } : {}) };
  }

  private throttles = new Map<string, { start: number; n: number; dropped: number }>();
  /**
   * Rate gate for chatty sources (a scanner hitting /api, a spinning client): true while `key` has logged fewer than `max`
   * entries in the current window. When a window ends with suppressed entries one summary line says how many.
   */
  allow(key: string, max = 30, windowMs = 60_000): boolean {
    const t = this.now();
    let w = this.throttles.get(key);
    if (!w || t - w.start > windowMs) {
      if (w?.dropped) this.warn('server', `${w.dropped} more "${key}" entries were not logged (rate limit)`);
      this.throttles.set(key, (w = { start: t, n: 0, dropped: 0 }));
      if (this.throttles.size > 200) this.throttles.clear();
    }
    if (w.n >= max) { w.dropped++; return false; }
    w.n++;
    return true;
  }

  /** Empties the in-memory buffer only (the file keeps its history). Returns how many entries were dropped. */
  clear(): number { return this.ring.clear(); }

  /** Plain-text export, redacted once more on the way out (defence in depth: the entries are already clean). */
  text(f: LogFilter = {}, header?: string): string {
    const { entries } = this.entries({ ...f, limit: f.limit ?? 5000 });
    const body = entries.map((e) => redactString(formatEntry(e), { secrets: this.secrets(), maxString: 20_000 })).join('\n');
    return `${header ? `${header}\n` : ''}${body}${body ? '\n' : ''}`;
  }
}

/** The process-wide logger. Tests that need isolation construct their own `Logger`. */
export const log = new Logger();

/**
 * Last-resort handlers for the real server process (cli.ts): the failure is written to the log (and file) before the
 * process ends. Node's default for both is to crash, and that is kept: a half-working server is worse than a stopped one.
 */
export function installProcessHandlers(logger: Logger = log, exit: (code: number) => void = (c) => process.exit(c)): void {
  process.on('uncaughtException', (err, origin) => {
    logger.error('server', 'Uncaught exception: the server is stopping', { error: err, origin });
    exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('server', 'Unhandled promise rejection: the server is stopping', { error: reason });
    exit(1);
  });
  process.on('warning', (w) => { logger.warn('server', `Node warning: ${w.name}: ${w.message}`); });
}
