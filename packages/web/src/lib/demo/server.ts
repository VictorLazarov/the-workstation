/**
 * In-browser fake server used for `?demo=1`: speaks the same protocol as the real server
 * (ClientMessage in, ServerMessage out) with deterministic, scripted SDK-shaped events.
 */
import type { ClientMessage, ContextUsage, PermissionDecision, ServerMessage, SessionRuntimeState } from '@workstation/protocol';
import type { ConnStatus, Transport } from '../transport/types';
import { demoGitCommit, demoGitDiff, demoGitRevert, demoGitStatus, demoReadFile } from './git';
import {
  DEMO_CWD, demoCommands, demoConfig, demoDirs, demoFiles, demoModels, demoSessions, richHistory,
} from './fixtures';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let idc = 0;
const rid = (p: string) => `${p}_${(++idc).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface DS {
  id: string; cwd: string; runtime: SessionRuntimeState; seq: number; abort: boolean; run: number;
  perms: Map<string, (d: PermissionDecision) => void>;
}

type B =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** Plausible context breakdown for the offline demo; the message share grows with the number of events seen. */
function demoContextUsage(seq: number, detail: 'summary' | 'full'): ContextUsage {
  const max = 200_000;
  const messages = 2_400 + seq * 310;
  const mcpTools = [
    { name: 'mcp__github__create_pull_request', serverName: 'github', tokens: 640, isLoaded: true },
    { name: 'mcp__github__list_issues', serverName: 'github', tokens: 520, isLoaded: true },
    { name: 'mcp__github__search_code', serverName: 'github', tokens: 480, isLoaded: true },
    { name: 'mcp__playwright__browser_click', serverName: 'playwright', tokens: 410, isLoaded: true },
    { name: 'mcp__playwright__browser_navigate', serverName: 'playwright', tokens: 390, isLoaded: true },
  ];
  const mcp = mcpTools.reduce((n, t) => n + t.tokens, 0);
  const used = messages + 11_800 + mcp + 3_100 + 640 + 420;
  const buffer = 33_000;
  return {
    source: 'sdk', detail, model: 'claude-sonnet-4-5', totalTokens: used, maxTokens: max, rawMaxTokens: max, percentage: (used / max) * 100, mcpTools,
    categories: [
      { name: 'Messages', tokens: messages, color: '', kind: 'used' }, { name: 'System tools', tokens: 11_800, color: '', kind: 'used' },
      { name: 'MCP tools', tokens: mcp, color: '', kind: 'used' }, { name: 'System prompt', tokens: 3_100, color: '', kind: 'used' },
      { name: 'Skills', tokens: 640, color: '', kind: 'used' }, { name: 'MCP server instructions', tokens: 420, color: '', kind: 'used' },
      { name: 'System tools (deferred)', tokens: 5_200, color: '', kind: 'deferred', isDeferred: true },
      { name: 'Autocompact buffer', tokens: buffer, color: '', kind: 'buffer' }, { name: 'Free space', tokens: max - used - buffer, color: '', kind: 'free' },
    ],
    isAutoCompactEnabled: true, autoCompactThreshold: max - buffer, apiUsage: null, at: Date.now(),
  };
}

class DemoBackend implements Transport {
  status: ConnStatus = 'closed';
  private msgCbs = new Set<(m: ServerMessage) => void>();
  private stCbs = new Set<(s: ConnStatus) => void>();
  private sessions = new Map<string, DS>();
  config = { ...demoConfig };
  summaries = demoSessions.map((s) => ({ ...s }));
  titles = new Map<string, string>();

  connect() {
    this.status = 'connecting';
    this.stCbs.forEach((c) => c('connecting'));
    setTimeout(() => {
      this.status = 'open';
      this.stCbs.forEach((c) => c('open'));
      this.out({ type: 'hello', version: 'demo', serverCwd: DEMO_CWD, mock: true });
    }, 120);
  }
  close() { this.status = 'closed'; this.stCbs.forEach((c) => c('closed')); }
  onMessage(cb: (m: ServerMessage) => void) { this.msgCbs.add(cb); return () => this.msgCbs.delete(cb); }
  onStatus(cb: (s: ConnStatus) => void) { this.stCbs.add(cb); return () => this.stCbs.delete(cb); }
  private out(m: ServerMessage) { this.msgCbs.forEach((c) => c(m)); }
  /** used by the demo "reconnect banner" tester */
  simulateDrop(ms = 2500) { this.close(); setTimeout(() => this.connect(), ms); }

  send(msg: ClientMessage): boolean {
    if (this.status !== 'open') return false;
    queueMicrotask(() => this.handle(msg));
    return true;
  }

  private emit(s: DS, message: unknown) { this.out({ type: 'sdk', sessionId: s.id, seq: ++s.seq, message }); }
  private state(s: DS, patch: Partial<SessionRuntimeState>) {
    s.runtime = { ...s.runtime, ...patch };
    this.out({ type: 'state', sessionId: s.id, state: s.runtime });
  }
  private initMsg(s: DS) {
    return {
      type: 'system', subtype: 'init', session_id: s.id, cwd: s.cwd, model: s.runtime.model ?? 'claude-sonnet-4-5',
      permissionMode: s.runtime.permissionMode, claude_code_version: '2.0.0-demo', apiKeySource: 'user', output_style: 'default',
      tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Task', 'TodoWrite', 'WebFetch'],
      slash_commands: demoCommands.map((c) => c.name), skills: ['pdf', 'frontend-design'], agents: ['code-reviewer', 'general-purpose'],
      mcp_servers: [{ name: 'github', status: 'connected' }, { name: 'playwright', status: 'connected' }], plugins: [], uuid: rid('i'),
    };
  }

  private handle(msg: ClientMessage) {
    switch (msg.type) {
      case 'ping': this.out({ type: 'pong' }); return;
      case 'session.start': case 'session.attach': {
        const resume = msg.type === 'session.start' ? msg.resume : msg.sessionId;
        const fork = msg.type === 'session.start' && msg.fork;
        const id = resume && !fork ? resume : rid('demo');
        let s = this.sessions.get(id);
        const cwd = msg.type === 'session.start' ? msg.cwd : this.summaries.find((x) => x.sessionId === id)?.cwd ?? DEMO_CWD;
        if (!s) {
          s = { id, cwd, seq: 0, abort: false, run: 0, perms: new Map(), runtime: {
            status: 'idle', permissionMode: (msg.type === 'session.start' && msg.permissionMode) || 'default',
            model: (msg.type === 'session.start' && msg.model) || this.config.defaultModel, effort: (msg.type === 'session.start' && msg.effort) || 'medium',
          } };
          this.sessions.set(id, s);
          if (!this.summaries.some((x) => x.sessionId === id))
            this.summaries.unshift({ sessionId: id, title: 'New session', cwd, gitBranch: demoGitStatus(cwd).branch, lastModified: Date.now(), live: true });
        }
        const sum = this.summaries.find((x) => x.sessionId === id); if (sum) sum.live = true;
        this.out({ type: 'ack', reqId: msg.reqId, ok: true });
        this.out({ type: 'session.started', reqId: msg.reqId, sessionId: id, cwd: s.cwd, init: this.initMsg(s) });
        this.out({ type: 'state', sessionId: id, state: s.runtime });
        if (id === 'demo-live' && s.runtime.status === 'idle' && !s.run) void this.scriptBackground(s);
        return;
      }
      case 'session.close': this.sessions.delete(msg.sessionId); return;
      case 'prompt': {
        const s = this.sessions.get(msg.sessionId); if (!s) return;
        const sum = this.summaries.find((x) => x.sessionId === s.id);
        if (sum && sum.title === 'New session') sum.title = msg.text.slice(0, 60);
        if (sum) sum.lastModified = Date.now();
        this.emit(s, { type: 'user', uuid: rid('um'), session_id: s.id, parent_tool_use_id: null, message: { role: 'user', content: msg.text } });
        void this.script(s, msg.text);
        return;
      }
      case 'interrupt': {
        const s = this.sessions.get(msg.sessionId); if (!s) return;
        s.abort = true;
        s.perms.forEach((r) => r({ behavior: 'deny', message: "The user doesn't want to proceed with this tool use. The tool use was rejected." }));
        return;
      }
      case 'permission.respond': {
        const s = this.sessions.get(msg.sessionId);
        s?.perms.get(msg.requestId)?.(msg.decision);
        return;
      }
      case 'set.model': { const s = this.sessions.get(msg.sessionId); if (s) this.state(s, { model: msg.model }); return; }
      case 'set.permissionMode': { const s = this.sessions.get(msg.sessionId); if (s) this.state(s, { permissionMode: msg.mode }); return; }
      case 'set.effort': { const s = this.sessions.get(msg.sessionId); if (s) this.state(s, { effort: msg.effort }); return; }
      case 'context.usage': {
        const s = this.sessions.get(msg.sessionId);
        if (!s) { this.out({ type: 'error', reqId: msg.reqId, sessionId: msg.sessionId, message: `no live session ${msg.sessionId}` }); return; }
        this.out({ type: 'ack', reqId: msg.reqId, ok: true, data: demoContextUsage(s.seq, msg.detail ?? 'full') });
        return;
      }
      case 'task.stop': this.out({ type: 'ack', reqId: msg.reqId, ok: true, data: { stopped: true } }); return;
      case 'rewind':
        this.out({ type: 'ack', reqId: msg.reqId, ok: true, data: msg.dryRun ? { canRewind: true, filesChanged: ['src/styles/theme.css', 'src/lib/useTheme.ts'], insertions: 25, deletions: 1 } : { canRewind: true } });
        return;
      default: return;
    }
  }

  /* ───────── script helpers ───────── */
  private async streamTurn(s: DS, blocks: B[], opts: { parent?: string | null; fast?: boolean } = {}) {
    const parent = opts.parent ?? null;
    const msgId = rid('msg');
    const base = { parent_tool_use_id: parent, session_id: s.id };
    const ev = (event: unknown) => this.emit(s, { type: 'stream_event', event, uuid: rid('e'), ...base });
    ev({ type: 'message_start', message: { id: msgId, role: 'assistant', content: [], usage: { input_tokens: 18_400 + Math.floor(Math.random() * 2000), cache_read_input_tokens: 0, output_tokens: 1 } } });
    const step = opts.fast ? 6 : 14;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (s.abort) return null;
      if (b.type === 'text' || b.type === 'thinking') {
        ev({ type: 'content_block_start', index: i, content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } });
        const parts = b.text.match(/\S+\s*|\s+/g) ?? [];
        for (let k = 0; k < parts.length; k += 2) {
          if (s.abort) return null;
          const chunk = parts.slice(k, k + 2).join('');
          ev({ type: 'content_block_delta', index: i, delta: b.type === 'text' ? { type: 'text_delta', text: chunk } : { type: 'thinking_delta', thinking: chunk } });
          await sleep(step + Math.random() * 10);
        }
        ev({ type: 'content_block_stop', index: i });
      } else {
        ev({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        const json = JSON.stringify(b.input);
        for (let k = 0; k < json.length; k += 40) {
          ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json.slice(k, k + 40) } });
          await sleep(opts.fast ? 2 : 8);
        }
        ev({ type: 'content_block_stop', index: i });
      }
      const content = b.type === 'thinking' ? { type: 'thinking', thinking: b.text } : b;
      this.emit(s, { type: 'assistant', uuid: rid('a'), message: { id: msgId, role: 'assistant', content: [content], usage: { input_tokens: 21_000, output_tokens: 300 } }, ...base });
    }
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } });
    ev({ type: 'message_stop' });
    return msgId;
  }

  private toolResult(s: DS, id: string, content: string, opts: { parent?: string | null; raw?: unknown; isError?: boolean } = {}) {
    this.emit(s, {
      type: 'user', uuid: rid('u'), session_id: s.id, parent_tool_use_id: opts.parent ?? null, tool_use_result: opts.raw,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!opts.isError }] },
    });
  }

  private ask(s: DS, toolName: string, input: Record<string, unknown>, toolUseID: string): Promise<PermissionDecision> {
    const mode = s.runtime.permissionMode;
    const auto = mode === 'bypassPermissions' || (mode === 'acceptEdits' && ['Edit', 'Write', 'MultiEdit'].includes(toolName));
    if (auto && toolName !== 'AskUserQuestion' && toolName !== 'ExitPlanMode') return Promise.resolve({ behavior: 'allow' });
    const requestId = rid('perm');
    return new Promise((resolve) => {
      s.perms.set(requestId, (d) => { s.perms.delete(requestId); this.state(s, { status: 'running' }); resolve(d); });
      this.out({ type: 'permission.request', sessionId: s.id, requestId, toolName, input, toolUseID, hasSuggestions: true,
        description: toolName === 'Bash' ? 'Run a shell command in your project' : undefined });
      this.state(s, { status: 'waiting_permission' });
    });
  }

  private async finish(s: DS, cost = 0.0412, durationMs = 9400) {
    if (s.abort) {
      // the real SDK's shape after an interrupt (see packages/server/test/fixtures/real-interrupt-stream.json)
      this.emit(s, { type: 'user', uuid: rid('u'), session_id: s.id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      this.emit(s, { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: durationMs, duration_api_ms: 0, num_turns: 2, stop_reason: null, terminal_reason: 'aborted_streaming', total_cost_usd: cost + s.seq * 0.00001, usage: {}, modelUsage: {}, permission_denials: [], errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'], session_id: s.id, uuid: rid('r') });
    } else {
      this.emit(s, { type: 'result', subtype: 'success', is_error: false, result: '', duration_ms: durationMs, duration_api_ms: durationMs - 800, num_turns: 3, total_cost_usd: cost + s.seq * 0.00001, usage: {}, modelUsage: {}, permission_denials: [], errors: [], session_id: s.id, uuid: rid('r') });
    }
    s.abort = false;
    this.state(s, { status: 'idle' });
  }

  private async script(s: DS, text: string) {
    const run = ++s.run;
    s.abort = false;
    this.state(s, { status: 'running' });
    const t = text.toLowerCase();
    try {
      if (/\b(ask|question|which)\b/.test(t)) await this.scriptQuestion(s);
      else if (/\bplan\b/.test(t)) await this.scriptPlan(s);
      else if (/\b(agent|subagent|parallel)\b/.test(t)) await this.scriptTask(s);
      else if (/\b(error|fail|retry)\b/.test(t)) await this.scriptRetry(s);
      else await this.scriptDefault(s, text);
    } finally { if (s.run === run) await this.finish(s); }
  }

  private async scriptDefault(s: DS, prompt: string) {
    const T = (x: B[]) => this.streamTurn(s, x);
    await sleep(250);
    await T([
      { type: 'thinking', text: 'Let me find where this is implemented before changing anything. I should search for the relevant symbols, read the surrounding code, then make a minimal edit and verify with the test suite.' },
      { type: 'text', text: `Sure, I'll take a look at that. Starting by finding the relevant code for "${prompt.slice(0, 60)}".` },
      { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'verifyToken|requireAuth', path: 'src' } },
    ]);
    if (s.abort) return;
    this.toolResult(s, 'g1', 'src/middleware/auth.ts:14\nsrc/routes/login.ts:32');
    await sleep(200);
    await T([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: `${s.cwd}/src/middleware/auth.ts` } }]);
    this.toolResult(s, 'r1', 'export function requireAuth() {...}');
    await T([
      { type: 'text', text: 'Found it. The middleware reads the token on every request and never caches the decoded claims. I will track this work as a short plan and then make the change.' },
      { type: 'tool_use', id: 'td1', name: 'TodoWrite', input: { todos: [
        { content: 'Cache decoded claims per request', status: 'in_progress', activeForm: 'Caching decoded claims' },
        { content: 'Run the auth tests', status: 'pending', activeForm: 'Running auth tests' },
      ] } },
    ]);
    this.toolResult(s, 'td1', 'ok');
    if (s.abort) return;
    const edit = {
      file_path: `${s.cwd}/src/middleware/auth.ts`,
      old_string: 'export function requireAuth(req: Request) {\n  const claims = verifyToken(req.headers.authorization);\n  return claims;\n}',
      new_string: 'const cache = new WeakMap<Request, Claims>();\n\nexport function requireAuth(req: Request) {\n  const hit = cache.get(req);\n  if (hit) return hit;\n  const claims = verifyToken(req.headers.authorization);\n  cache.set(req, claims);\n  return claims;\n}',
    };
    await T([{ type: 'tool_use', id: 'e1', name: 'Edit', input: edit }]);
    const d = await this.ask(s, 'Edit', edit, 'e1');
    if (d.behavior === 'deny') { this.toolResult(s, 'e1', d.message || 'The user denied this action.', { isError: true }); await T([{ type: 'text', text: "Understood, I won't edit that file. Let me know how you'd like to proceed." }]); return; }
    this.toolResult(s, 'e1', 'The file has been updated.');
    const cmd = { command: 'npm test -- auth', description: 'Run auth tests' };
    await T([{ type: 'tool_use', id: 'b1', name: 'Bash', input: cmd }]);
    const d2 = await this.ask(s, 'Bash', cmd, 'b1');
    if (d2.behavior === 'deny') { this.toolResult(s, 'b1', d2.message || 'The user denied this action.', { isError: true }); await T([{ type: 'text', text: 'Skipping the test run as requested.' }]); return; }
    await sleep(500);
    this.toolResult(s, 'b1', '> vitest run auth\n\n ✓ tests/auth.test.ts (8 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  8 passed (8)');
    await T([
      { type: 'tool_use', id: 'td2', name: 'TodoWrite', input: { todos: [
        { content: 'Cache decoded claims per request', status: 'completed', activeForm: 'Caching decoded claims' },
        { content: 'Run the auth tests', status: 'completed', activeForm: 'Running auth tests' },
      ] } },
      { type: 'text', text: 'Done. `requireAuth` now memoizes the decoded claims per request with a `WeakMap`, so repeated calls within one request skip token verification.\n\n- **Tests:** all 8 auth tests pass\n- **Risk:** low, the cache is request-scoped and garbage collected with it\n\nWant me to add a benchmark to quantify the improvement?' },
    ]);
    this.toolResult(s, 'td2', 'ok');
  }

  private async scriptQuestion(s: DS) {
    const q = { questions: [
      { question: 'Which storage should the theme preference use?', header: 'Storage', multiSelect: false, options: [
        { label: 'localStorage', description: 'Simple, per-browser, synchronous' },
        { label: 'Cookie', description: 'Readable by the server for SSR without a flash' },
        { label: 'User profile (API)', description: 'Follows the user across devices' },
      ] },
      { question: 'Which extras do you want?', header: 'Extras', multiSelect: true, options: [
        { label: 'System option', description: 'Follow the OS preference' },
        { label: 'Keyboard shortcut', description: 'Toggle with a key binding' },
      ] },
    ] };
    await this.streamTurn(s, [{ type: 'text', text: 'Before I start I need to settle a couple of design choices.' }, { type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: q }]);
    const d = await this.ask(s, 'AskUserQuestion', q, 'q1');
    this.toolResult(s, 'q1', d.behavior === 'allow' ? 'User has answered your questions.' : 'The user declined to answer.', { isError: d.behavior === 'deny' });
    await this.streamTurn(s, [{ type: 'text', text: d.behavior === 'allow' ? 'Great, got your answers. I will build it that way.' : 'No problem, I will pick sensible defaults.' }]);
  }

  private async scriptPlan(s: DS) {
    const plan = '## Plan: add theme persistence\n\n1. **Palette**: add a dark token set keyed on `data-theme`\n2. **Hook**: `useTheme()` persists to `localStorage`, defaults to the OS preference\n3. **UI**: radio group in Settings > Appearance\n4. **Tests**: hook unit tests + a Playwright check for both themes\n\n_Estimated: 4 files changed, no new dependencies._';
    await this.streamTurn(s, [
      { type: 'thinking', text: 'The change touches styling, state and UI. Worth proposing a plan before editing files.' },
      { type: 'text', text: "I've drafted a plan for your review." },
      { type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan } },
    ]);
    const d = await this.ask(s, 'ExitPlanMode', { plan }, 'p1');
    this.toolResult(s, 'p1', d.behavior === 'allow' ? 'User has approved your plan.' : 'The user rejected the plan.', { isError: d.behavior === 'deny' });
    await this.streamTurn(s, [{ type: 'text', text: d.behavior === 'allow' ? 'Plan approved. Starting with the palette.' : 'Understood. Tell me what to change in the plan and I will revise it.' }]);
  }

  private async scriptTask(s: DS) {
    const input = { subagent_type: 'general-purpose', description: 'Audit API routes for missing auth', prompt: 'Look through src/routes and list handlers without requireAuth.' };
    await this.streamTurn(s, [{ type: 'text', text: 'I will delegate the audit to a subagent so I can keep working.' }, { type: 'tool_use', id: 'tk1', name: 'Task', input }]);
    this.emit(s, { type: 'system', subtype: 'task_started', task_id: 'tsk1', tool_use_id: 'tk1', description: input.description, subagent_type: 'general-purpose', session_id: s.id, uuid: rid('t') });
    const p = 'tk1';
    await this.streamTurn(s, [{ type: 'tool_use', id: 'sg1', name: 'Glob', input: { pattern: 'src/routes/**/*.ts' } }], { parent: p, fast: true });
    this.toolResult(s, 'sg1', 'src/routes/login.ts\nsrc/routes/users.ts\nsrc/routes/health.ts', { parent: p });
    this.emit(s, { type: 'system', subtype: 'task_progress', task_id: 'tsk1', tool_use_id: 'tk1', description: input.description, usage: { total_tokens: 4200, tool_uses: 1, duration_ms: 1800 }, last_tool_name: 'Glob', session_id: s.id, uuid: rid('t') });
    await sleep(300);
    await this.streamTurn(s, [{ type: 'tool_use', id: 'sg2', name: 'Grep', input: { pattern: 'requireAuth', path: 'src/routes' } }], { parent: p, fast: true });
    this.toolResult(s, 'sg2', 'src/routes/users.ts:9\nsrc/routes/login.ts:4', { parent: p });
    this.emit(s, { type: 'system', subtype: 'task_progress', task_id: 'tsk1', tool_use_id: 'tk1', description: input.description, usage: { total_tokens: 9100, tool_uses: 2, duration_ms: 3900 }, last_tool_name: 'Grep', session_id: s.id, uuid: rid('t') });
    await sleep(400);
    this.emit(s, { type: 'system', subtype: 'task_notification', task_id: 'tsk1', tool_use_id: 'tk1', status: 'completed', summary: 'One public route found: health.ts (intentional).', output_file: '', usage: { total_tokens: 11800, tool_uses: 2, duration_ms: 5200 }, session_id: s.id, uuid: rid('t') });
    this.toolResult(s, 'tk1', 'Audit complete: `src/routes/health.ts` is the only unauthenticated route, and it is intentionally public.');
    await this.streamTurn(s, [{ type: 'text', text: 'The subagent finished. Every route requires auth except `/health`, which is intentional.' }]);
  }

  private async scriptRetry(s: DS) {
    await sleep(300);
    this.emit(s, { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 6, retry_delay_ms: 3000, error_status: 529, error: 'overloaded', session_id: s.id, uuid: rid('x') });
    await sleep(3200);
    await this.streamTurn(s, [{ type: 'text', text: 'The API was briefly overloaded, but the retry succeeded. Everything is fine now.' }]);
  }

  /** The always-"running" background session shown in the sidebar. */
  private async scriptBackground(s: DS) {
    s.run++;
    this.state(s, { status: 'running' });
    this.emit(s, { type: 'user', uuid: rid('um'), session_id: s.id, parent_tool_use_id: null, message: { role: 'user', content: 'Migrate the build from Vite 5 to Vite 6 and fix any breaking config changes.' } });
    await this.streamTurn(s, [
      { type: 'text', text: 'On it. Let me check the current Vite config and plugin versions first.' },
      { type: 'tool_use', id: 'bg1', name: 'Read', input: { file_path: `${s.cwd}/vite.config.ts` } },
    ], { fast: true });
    this.toolResult(s, 'bg1', 'export default defineConfig({...})');
    await sleep(1200);
    const cmd = { command: 'npm install vite@6 @vitejs/plugin-react@latest', description: 'Upgrade Vite and the React plugin' };
    await this.streamTurn(s, [{ type: 'tool_use', id: 'bg2', name: 'Bash', input: cmd }], { fast: true });
    const d = await this.ask(s, 'Bash', cmd, 'bg2');
    this.toolResult(s, 'bg2', d.behavior === 'allow' ? 'added 4 packages in 3s' : 'The user denied this action.', { isError: d.behavior === 'deny' });
    await this.streamTurn(s, [{ type: 'text', text: d.behavior === 'allow' ? 'Upgraded. Now checking for deprecated config options.' : 'Okay, leaving dependencies untouched.' }], { fast: true });
    await this.finish(s, 0.12, 21000);
  }
}

export const demoBackend = new DemoBackend();
export function createDemoTransport(): Transport & { simulateDrop(ms?: number): void } { return demoBackend; }

/* ───────── REST ───────── */
export async function demoRest<T>(method: string, path: string, q: Record<string, string | undefined>, body: unknown): Promise<T> {
  await sleep(60);
  const b = demoBackend;
  const ok = (v: unknown) => v as T;
  if (path === '/api/health') return ok({ ok: true, cwd: DEMO_CWD, version: 'demo' });
  if (path === '/api/config') {
    if (method === 'PUT') {
      const p = { ...(body as Record<string, unknown>) };
      if (p.apiKey) { b.config.hasApiKey = true; delete p.apiKey; }
      if (p.authToken) { b.config.hasAuthToken = true; delete p.authToken; }
      b.config = { ...b.config, ...p };
    }
    return ok(b.config);
  }
  if (path === '/api/models') return ok(demoModels);
  if (path === '/api/commands') return ok(demoCommands);
  if (path === '/api/sessions' && method === 'GET') {
    return ok(b.summaries.filter((s) => !q.cwd || s.cwd === q.cwd).map((s) => ({ ...s, title: b.titles.get(s.sessionId) ?? s.title })));
  }
  const m = /^\/api\/sessions\/([^/]+)(\/messages)?$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2]) return ok({ messages: id === 'demo-rich' ? richHistory() : id === 'demo-live' ? [] : [] });
    if (method === 'PATCH') { b.titles.set(id, String((body as { title: string }).title)); return ok({ ok: true }); }
    if (method === 'DELETE') { b.summaries = b.summaries.filter((s) => s.sessionId !== id); return ok({ ok: true }); }
  }
  if (path === '/api/fs/list') {
    const p = (q.path || '/').replace(/\/+$/, '') || '/';
    const list = demoDirs[p] ?? [{ name: 'src', kind: 'dir' as const }, { name: 'README.md', kind: 'file' as const }];
    return ok(list.map((e) => ({ name: e.name, kind: e.kind, path: (p === '/' ? '' : p) + '/' + e.name })));
  }
  if (path === '/api/files/search') {
    const needle = (q.q ?? '').toLowerCase();
    return ok(demoFiles.filter((f) => !needle || f.toLowerCase().includes(needle)).slice(0, 8));
  }
  if (path === '/api/git/status') return ok(demoGitStatus(q.cwd));
  if (path === '/api/git/diff') return ok({ diff: demoGitDiff(q.path) });
  if (path === '/api/git/commit') return ok(demoGitCommit((body as { message?: unknown })?.message));
  if (path === '/api/git/revert') return ok(demoGitRevert((body as { path?: unknown })?.path));
  if (path === '/api/fs/read') return ok(demoReadFile(q.path ?? ''));
  throw new Error(`demo: unhandled ${method} ${path}`);
}
