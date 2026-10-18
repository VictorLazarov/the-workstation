/**
 * What the diagnostics log learns from the Agent SDK stream and the CLI process: API errors (code, HTTP status, the provider's own
 * words, request ids), turn outcomes, MCP status changes and the CLI's stderr. Kept apart from session-manager.ts so the
 * session logic stays readable. Nothing here logs prompts, assistant text or tool input/output.
 */
import type { LogLevel } from '@workstation/protocol';
import { log as defaultLog, type Logger } from './log.js';

type Msg = {
  type?: string; subtype?: string; error?: unknown; error_status?: number | null; api_error_status?: number | null; is_error?: boolean;
  attempt?: number; max_retries?: number; retry_delay_ms?: number; no_response?: unknown; errors?: unknown; stop_reason?: string | null;
  terminal_reason?: unknown; duration_ms?: number; num_turns?: number; total_cost_usd?: number; model?: string; permissionMode?: string;
  claude_code_version?: string; tools?: unknown[]; mcp_servers?: unknown;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

const REQUEST_ID = /\b(req_[A-Za-z0-9]{8,}|request[_ -]?id["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,})/i;
/** Anthropic request ids (`req_011…`) as they appear in error text; they are what support asks for. */
export function requestIdIn(text: string | undefined): string | undefined {
  const m = text ? REQUEST_ID.exec(text) : null;
  return m ? m[1]!.replace(/^request[_ -]?id["']?\s*[:=]\s*["']?/i, '') : undefined;
}

const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);
const strings = (v: unknown, max = 3): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => clip(x)) : []);
const assistantText = (m: Msg) => (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').trim();

const MCP_LEVEL: Record<string, LogLevel> = { connected: 'info', failed: 'error', 'needs-auth': 'warn', pending: 'debug', disabled: 'info' };
const mcpLast = new Map<string, Map<string, string>>();

/** Logs MCP servers whose status changed since the last look (first sight counts as a change). */
export function logMcpStatus(sessionId: string, list: unknown, logger: Logger = defaultLog): void {
  if (!Array.isArray(list)) return;
  let prev = mcpLast.get(sessionId);
  if (!prev) mcpLast.set(sessionId, (prev = new Map()));
  for (const x of list) {
    if (!x || typeof x !== 'object' || typeof (x as { name?: unknown }).name !== 'string') continue;
    const { name, status, error } = x as { name: string; status?: unknown; error?: unknown };
    const st = String(status ?? 'unknown');
    if (prev.get(name) === st) continue;
    prev.set(name, st);
    logger.log(MCP_LEVEL[st] ?? 'info', 'mcp', `MCP server "${name}": ${st}`, typeof error === 'string' && error ? { server: name, error: clip(error) } : { server: name }, sessionId);
  }
}
export function forgetMcp(sessionId: string): void { mcpLast.delete(sessionId); }

/** Called for every SDK message of a session (before it is forwarded). Cheap for the high-volume types. */
export function logSdkMessage(sessionId: string, raw: unknown, logger: Logger = defaultLog): void {
  const m = raw as Msg;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'stream_event' || m.type === 'user') return;
  if (m.type === 'assistant') {
    if (typeof m.error !== 'string') return;
    const said = assistantText(m);
    logger.error('sdk', `API error: ${m.error}`, {
      code: m.error, ...(typeof m.api_error_status === 'number' ? { status: m.api_error_status } : {}),
      ...(said ? { providerMessage: clip(said) } : {}), ...(requestIdIn(said) ? { requestId: requestIdIn(said) } : {}),
    }, sessionId);
    return;
  }
  if (m.type === 'system') {
    if (m.subtype === 'api_retry') {
      const code = typeof m.error === 'string' ? m.error : 'unknown';
      logger.warn('sdk', `API error ${m.error_status ?? '(no response)'}: ${code}, retry ${m.attempt ?? '?'}/${m.max_retries ?? '?'}`, {
        code, status: m.error_status ?? null, attempt: m.attempt, maxRetries: m.max_retries, retryDelayMs: m.retry_delay_ms, ...(m.no_response ? { noResponse: m.no_response } : {}),
      }, sessionId);
    } else if (m.subtype === 'init') {
      logger.info('sdk', 'Agent initialized', { model: m.model, permissionMode: m.permissionMode, claudeCodeVersion: m.claude_code_version, tools: Array.isArray(m.tools) ? m.tools.length : undefined }, sessionId);
      logMcpStatus(sessionId, m.mcp_servers, logger);
    }
    return;
  }
  if (m.type === 'result') {
    if (m.is_error) {
      const errors = strings(m.errors);
      const req = requestIdIn(errors.join(' '));
      logger.error('sdk', `Turn ended with an error${m.subtype ? ` (${m.subtype})` : ''}`, {
        subtype: m.subtype, ...(typeof m.api_error_status === 'number' ? { status: m.api_error_status } : {}), stopReason: m.stop_reason ?? undefined,
        ...(m.terminal_reason ? { terminalReason: m.terminal_reason } : {}), ...(errors.length ? { errors } : {}), ...(req ? { requestId: req } : {}),
        durationMs: m.duration_ms, turns: m.num_turns,
      }, sessionId);
    } else {
      logger.debug('sdk', 'Turn finished', { durationMs: m.duration_ms, turns: m.num_turns, costUsd: m.total_cost_usd }, sessionId);
    }
  }
}

const ERROR_RE = /\b(fatal|panic|uncaught|unhandled)\b/i;
const WARN_RE = /\b(error|exception|failed|failure|denied|refused|timeout|timed out|ECONN\w*|ENOTFOUND|EACCES)\b/i;
export const STDERR_LINES_PER_MINUTE = 300;

/**
 * The `stderr` callback for one Claude Code process: chunks become whole lines, each one log entry (source `cli-stderr`).
 * A runaway process cannot flood the log: past STDERR_LINES_PER_MINUTE lines in a minute the rest is counted and summarised.
 */
export function createStderrLogger(sessionId: string, logger: Logger = defaultLog, now: () => number = Date.now): (chunk: string) => void {
  let partial = '';
  let windowStart = now(), lines = 0, dropped = 0;
  let timer: NodeJS.Timeout | undefined;
  const emit = (line: string) => {
    const t = now();
    if (t - windowStart > 60_000) {
      if (dropped) logger.warn('cli-stderr', `${dropped} more stderr line${dropped === 1 ? '' : 's'} not logged (rate limit)`, undefined, sessionId);
      windowStart = t; lines = 0; dropped = 0;
    }
    if (lines++ >= STDERR_LINES_PER_MINUTE) { dropped++; return; }
    const level: LogLevel = ERROR_RE.test(line) ? 'error' : WARN_RE.test(line) ? 'warn' : 'info';
    logger.log(level, 'cli-stderr', clip(line, 1500), undefined, sessionId);
  };
  const flush = () => { timer = undefined; const rest = partial.trim(); partial = ''; if (rest) emit(rest); };
  return (chunk) => {
    partial += String(chunk);
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) emit(p.trimEnd());
    if (timer) clearTimeout(timer);
    if (partial) { timer = setTimeout(flush, 400); timer.unref?.(); }
  };
}
