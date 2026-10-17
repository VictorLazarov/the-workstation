/**
 * Deterministic fake of the Agent SDK (WORKSTATION_MOCK=1) so the web UI and e2e tests run offline.
 *
 * Scenario is chosen from keywords in the prompt text (case-insensitive):
 *   "demo" / "everything"  -> full tour: thinking, TodoWrite, Read/Grep/Glob, Bash (permission), Edit + Write
 *                             (permission), Task subagent (nested), WebSearch/WebFetch, markdown answer, result
 *   "bash"   -> one Bash command needing permission (+ "Always allow" suggestion)
 *   "edit"   -> one Edit needing permission (diff card)
 *   "write"  -> one Write needing permission
 *   "todo"   -> TodoWrite progression
 *   "task"   -> Task/subagent group with nested messages and system task_* events
 *   "web"    -> WebSearch + WebFetch
 *   "ask"    -> AskUserQuestion (answer via permission.respond updatedInput {questions, answers})
 *   "plan"   -> ExitPlanMode plan review
 *   "slow"   -> ~6s of streamed text, interruptible
 *   "error"  -> result with is_error
 *   anything else -> short streamed markdown reply (with a thinking block)
 * Set WORKSTATION_MOCK_SPEED=0 for no delays (tests), 2 for double speed, default 1.
 */
import { randomUUID } from 'node:crypto';
import type { CanUseTool, ModelInfo, Options, PermissionUpdate, SDKSessionInfo, SDKUserMessage, SessionMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { QueryHandle, SdkAdapter } from './sdk.js';

type Json = Record<string, unknown>;

export const MOCK_MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Mock default model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Mock Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'opus', displayName: 'Opus', description: 'Mock Opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Mock Haiku' },
];

export const MOCK_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free context', argumentHint: '[instructions]' },
  { name: 'review', description: 'Review a pull request', argumentHint: '[pr]' },
  { name: 'init', description: 'Create a CLAUDE.md file', argumentHint: '' },
  { name: 'mock-skill', description: 'A project skill from the mock', argumentHint: '<arg>' },
];

interface MockSession { id: string; cwd: string; title: string; created: number; modified: number; messages: SessionMessage[] }

const speed = () => {
  const s = Number(process.env.WORKSTATION_MOCK_SPEED ?? '1');
  return Number.isFinite(s) ? s : 1;
};
const sleep = (ms: number) => (speed() <= 0 ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms / speed())));

class AsyncSignal {
  private waiters: Array<() => void> = [];
  fire() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  wait() { return new Promise<void>((r) => this.waiters.push(r)); }
}

class MockQuery implements QueryHandle {
  private gen: AsyncGenerator<unknown, void>;
  private permissionMode: string;
  private model: string;
  private aborted = false;
  private abortCtl = new AbortController();
  private closed = false;
  private mcp = new Map<string, boolean>([['mock-mcp', true], ['docs', true]]);
  private toolN = 0;
  private num_turns = 0;
  private wake = new AsyncSignal();
  readonly sessionId: string;
  private session: MockSession;

  constructor(private params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }, private store: Map<string, MockSession>) {
    const o = params.options;
    this.permissionMode = o.permissionMode ?? 'default';
    this.model = o.model ?? 'default';
    this.sessionId = o.sessionId ?? (o.resume && !o.forkSession ? o.resume : randomUUID());
    const prior = o.resume ? store.get(o.resume) : undefined;
    const existing = store.get(this.sessionId) ?? (prior ? { ...prior, id: this.sessionId, messages: [...prior.messages] } : undefined);
    this.session = existing ?? { id: this.sessionId, cwd: o.cwd ?? process.cwd(), title: '', created: Date.now(), modified: Date.now(), messages: [] };
    if (!this.session.cwd) this.session.cwd = o.cwd ?? process.cwd();
    this.gen = this.run();
  }

  // ───── AsyncGenerator plumbing ─────
  next(...a: [] | [undefined]) { return this.gen.next(...a); }
  return(v?: void | PromiseLike<void>) { this.close(); return this.gen.return(v as void); }
  throw(e: unknown) { return this.gen.throw(e); }
  [Symbol.asyncIterator]() { return this; }
  [Symbol.asyncDispose]() { this.close(); return Promise.resolve(); }

  // ───── control surface ─────
  async interrupt() { this.aborted = true; this.abortCtl.abort(); this.wake.fire(); return undefined; }
  async setModel(m?: string) { this.model = m ?? 'default'; }
  async setPermissionMode(m: string) { this.permissionMode = m; }
  async applyFlagSettings(_s: Record<string, unknown>) { /* accepted */ }
  async rewindFiles(userMessageId: string, o?: { dryRun?: boolean }) {
    const known = this.session.messages.some((m) => m.uuid === userMessageId);
    if (!known) return { canRewind: false, error: `No checkpoint for message ${userMessageId}` };
    return { canRewind: true, filesChanged: ['src/example.ts', 'README.md'], insertions: o?.dryRun ? 3 : 0, deletions: o?.dryRun ? 1 : 0 };
  }
  async mcpServerStatus() {
    return [...this.mcp].map(([name, on]) => ({ name, status: on ? 'connected' : 'disabled', serverInfo: { name, version: '1.0.0' } }));
  }
  async toggleMcpServer(name: string, enabled: boolean) { this.mcp.set(name, enabled); }
  async reconnectMcpServer(name: string) { if (!this.mcp.has(name)) throw new Error(`Unknown MCP server: ${name}`); }
  async supportedModels() { return MOCK_MODELS; }
  async supportedCommands() { return MOCK_COMMANDS; }
  async initializationResult() {
    return { commands: MOCK_COMMANDS, models: MOCK_MODELS, agents: [], current_permission_mode: this.permissionMode };
  }
  close() {
    this.closed = true;
    this.abortCtl.abort();
    this.wake.fire();
    this.store.set(this.session.id, this.session);
  }

  // ───── message builders ─────
  private m<T extends Json>(p: T): T & { uuid: string; session_id: string } {
    return { ...p, uuid: randomUUID(), session_id: this.sessionId };
  }
  private toolId() { return `toolu_mock_${String(++this.toolN).padStart(4, '0')}`; }

  private initMsg() {
    return this.m({
      type: 'system', subtype: 'init', cwd: this.session.cwd, model: this.model, permissionMode: this.permissionMode,
      tools: ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob', 'TodoWrite', 'Task', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ExitPlanMode'],
      mcp_servers: [...this.mcp].map(([name, on]) => ({ name, status: on ? 'connected' : 'disabled' })),
      slash_commands: MOCK_COMMANDS.map((c) => c.name), skills: ['mock-skill'], agents: ['general-purpose', 'Explore'], plugins: [],
      apiKeySource: 'none', claude_code_version: '0.0.0-mock', output_style: 'default',
    });
  }

  private record(role: 'user' | 'assistant', message: unknown, uuid: string, parent: string | null = null) {
    this.session.messages.push({ type: role, uuid, session_id: this.sessionId, message, parent_tool_use_id: parent, parent_agent_id: null } as SessionMessage);
    this.session.modified = Date.now();
    this.store.set(this.session.id, this.session);
  }

  private stream(event: Json, parent: string | null = null) {
    return this.m({ type: 'stream_event', event, parent_tool_use_id: parent });
  }

  /** Stream a set of content blocks and emit the complete assistant message. */
  private async *step(blocks: Json[], parent: string | null = null): AsyncGenerator<unknown, void> {
    const msgId = `msg_mock_${randomUUID().slice(0, 8)}`;
    yield this.stream({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: this.model, content: [], usage: { input_tokens: 120, output_tokens: 1 } } }, parent);
    let idx = 0;
    for (const b of blocks) {
      if (this.aborted) return;
      if (b.type === 'text') {
        yield this.stream({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }, parent);
        for (const chunk of chunkText(String(b.text))) {
          if (this.aborted) return;
          yield this.stream({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: chunk } }, parent);
          await sleep(12);
        }
      } else if (b.type === 'thinking') {
        yield this.stream({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } }, parent);
        for (const chunk of chunkText(String(b.thinking))) {
          if (this.aborted) return;
          yield this.stream({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: chunk } }, parent);
          await sleep(10);
        }
        yield this.stream({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: 'mock-signature' } }, parent);
      } else if (b.type === 'tool_use') {
        yield this.stream({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }, parent);
        const json = JSON.stringify(b.input);
        for (let i = 0; i < json.length; i += 24) {
          yield this.stream({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 24) } }, parent);
          await sleep(5);
        }
      }
      yield this.stream({ type: 'content_block_stop', index: idx }, parent);
      idx++;
    }
    const hasTool = blocks.some((b) => b.type === 'tool_use');
    const content = blocks.map((b) => (b.type === 'thinking' ? { ...b, signature: 'mock-signature' } : b));
    const message = {
      id: msgId, type: 'message', role: 'assistant', model: this.model, content, stop_reason: hasTool ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 40 + content.length * 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
    };
    const uuid = randomUUID();
    this.record('assistant', message, uuid, parent);
    yield { type: 'assistant', message, parent_tool_use_id: parent, uuid, session_id: this.sessionId };
    yield this.stream({ type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: message.usage.output_tokens } }, parent);
    yield this.stream({ type: 'message_stop' }, parent);
    this.num_turns++;
  }

  private toolResult(toolUseId: string, content: string | Json[], isError = false, structured?: unknown, parent: string | null = null) {
    const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] };
    const uuid = randomUUID();
    this.record('user', message, uuid, parent);
    return { type: 'user', message, parent_tool_use_id: parent, uuid, session_id: this.sessionId, tool_use_result: structured ?? undefined };
  }

  private needsPermission(tool: string): boolean {
    if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return true;
    if (this.permissionMode === 'bypassPermissions' || this.permissionMode === 'dontAsk') return false;
    if (this.permissionMode === 'acceptEdits' && (tool === 'Edit' || tool === 'Write')) return false;
    return ['Bash', 'Edit', 'Write', 'WebFetch'].includes(tool);
  }

  /** Ask the host via canUseTool; returns the (possibly rewritten) input or an error text on deny. */
  private async ask(tool: string, input: Json, toolUseID: string, extra: { suggestions?: PermissionUpdate[]; title?: string; description?: string; decisionReason?: string; blockedPath?: string } = {}) {
    const cb: CanUseTool | undefined = this.params.options.canUseTool;
    if (!this.needsPermission(tool) || !cb) return { ok: true as const, input };
    const res = await cb(tool, input, { signal: this.abortCtl.signal, toolUseID, requestId: randomUUID(), ...extra });
    if (res && res.behavior === 'allow') return { ok: true as const, input: (res.updatedInput ?? input) as Json };
    const d = res as { message?: string; interrupt?: boolean } | null;
    return { ok: false as const, message: d?.message ?? 'denied', interrupt: !!d?.interrupt };
  }

  // ───── scenarios ─────
  private async *scenario(text: string, hasImages: number): AsyncGenerator<unknown, string> {
    const t = text.toLowerCase();
    const has = (...w: string[]) => w.some((x) => new RegExp(`\\b${x}`).test(t));
    let final = '';
    if (has('demo', 'everything')) {
      yield* this.demo();
      final = 'Demo complete.';
    } else if (has('bash')) final = yield* this.bashScenario();
    else if (has('edit')) final = yield* this.editScenario();
    else if (has('write')) final = yield* this.writeScenario();
    else if (has('todo')) final = yield* this.todoScenario();
    else if (has('task', 'subagent')) final = yield* this.taskScenario();
    else if (has('web')) final = yield* this.webScenario();
    else if (has('ask')) final = yield* this.askScenario();
    else if (has('plan')) final = yield* this.planScenario();
    else if (has('slow')) final = yield* this.slowScenario();
    else if (has('error')) return '__error__';
    else {
      final = `Here is a **mock** reply to: "${text.slice(0, 200)}"${hasImages ? `\n\nI can see ${hasImages} attached image${hasImages > 1 ? 's' : ''}.` : ''}\n\n- deterministic output\n- streamed in small chunks\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n`;
      yield* this.step([{ type: 'thinking', thinking: 'The user sent a plain message. I will answer briefly with some markdown.' }, { type: 'text', text: final }]);
    }
    return final;
  }

  private async *bashScenario(): AsyncGenerator<unknown, string> {
    const id = this.toolId();
    const input = { command: 'npm test -- --reporter=dot', description: 'Run the test suite' };
    yield* this.step([{ type: 'text', text: "I'll run the tests." }, { type: 'tool_use', id, name: 'Bash', input }]);
    const r = await this.ask('Bash', input, id, {
      title: 'Claude wants to run: npm test -- --reporter=dot', description: 'Run the test suite',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }],
    });
    if (!r.ok) { yield this.toolResult(id, r.message, true); return yield* this.finish(`The command was denied: ${r.message}`); }
    yield this.toolResult(id, '\n> demo@1.0.0 test\n> vitest run --reporter=dot\n\n....................\n\n Test Files  3 passed (3)\n      Tests  20 passed (20)\n', false, { stdout: 'Test Files  3 passed (3)\nTests  20 passed (20)\n', stderr: '', interrupted: false });
    return yield* this.finish('All **20 tests** pass.');
  }

  private async *editScenario(): AsyncGenerator<unknown, string> {
    const id = this.toolId();
    const file = `${this.session.cwd}/src/example.ts`;
    const input = { file_path: file, old_string: 'export const greeting = "hello";', new_string: 'export const greeting = "hello, world";\nexport const farewell = "bye";' };
    yield* this.step([{ type: 'text', text: 'Updating the greeting.' }, { type: 'tool_use', id, name: 'Edit', input }]);
    const r = await this.ask('Edit', input, id, {
      title: `Claude wants to edit ${file}`, blockedPath: undefined,
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    if (!r.ok) { yield this.toolResult(id, r.message, true); return yield* this.finish(`Edit denied: ${r.message}`); }
    yield this.toolResult(id, `The file ${file} has been updated.`, false, {
      filePath: file, oldString: input.old_string, newString: input.new_string, originalFile: 'export const greeting = "hello";\n',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-export const greeting = "hello";', '+export const greeting = "hello, world";', '+export const farewell = "bye";'] }],
    });
    return yield* this.finish('Edited `src/example.ts` (+2 -1).');
  }

  private async *writeScenario(): AsyncGenerator<unknown, string> {
    const id = this.toolId();
    const file = `${this.session.cwd}/NOTES.md`;
    const input = { file_path: file, content: '# Notes\n\nCreated by the mock agent.\n' };
    yield* this.step([{ type: 'text', text: 'Creating a notes file.' }, { type: 'tool_use', id, name: 'Write', input }]);
    const r = await this.ask('Write', input, id, { title: `Claude wants to create ${file}` });
    if (!r.ok) { yield this.toolResult(id, r.message, true); return yield* this.finish(`Write denied: ${r.message}`); }
    yield this.toolResult(id, `File created successfully at: ${file}`, false, { type: 'create', filePath: file, content: input.content, structuredPatch: [] });
    return yield* this.finish('Created `NOTES.md`.');
  }

  private todos(statuses: string[]) {
    const items = ['Read the codebase', 'Implement the change', 'Run the tests'];
    return items.map((content, i) => ({ content, activeForm: ['Reading the codebase', 'Implementing the change', 'Running the tests'][i], status: statuses[i] }));
  }
  private async *todoScenario(): AsyncGenerator<unknown, string> {
    for (const s of [['in_progress', 'pending', 'pending'], ['completed', 'in_progress', 'pending'], ['completed', 'completed', 'completed']]) {
      const id = this.toolId();
      yield* this.step([{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: this.todos(s) } }]);
      yield this.toolResult(id, 'Todos have been modified successfully.');
    }
    return yield* this.finish('Todo list updated.');
  }

  private async *taskScenario(): AsyncGenerator<unknown, string> {
    const id = this.toolId();
    const input = { description: 'Explore the repo', subagent_type: 'Explore', prompt: 'Find where the greeting is defined.' };
    yield* this.step([{ type: 'text', text: 'Delegating to a subagent.' }, { type: 'tool_use', id, name: 'Task', input }]);
    const taskId = `task_mock_${randomUUID().slice(0, 6)}`;
    yield this.m({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, description: input.description, task_type: 'local_agent' });
    const rid = this.toolId();
    yield* this.step([{ type: 'text', text: 'Searching for the greeting definition...' }, { type: 'tool_use', id: rid, name: 'Grep', input: { pattern: 'greeting', path: 'src' } }], id);
    yield this.toolResult(rid, 'src/example.ts:1:export const greeting = "hello";', false, undefined, id);
    yield this.m({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: id, description: input.description, usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 900 }, last_tool_name: 'Grep' });
    yield* this.step([{ type: 'text', text: 'Found it in `src/example.ts`.' }], id);
    yield this.m({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: id, status: 'completed', summary: input.description, output_file: '' });
    yield this.toolResult(id, [{ type: 'text', text: 'The greeting is defined in src/example.ts line 1.' }], false, { status: 'completed', content: [{ type: 'text', text: 'The greeting is defined in src/example.ts line 1.' }], totalDurationMs: 900, totalTokens: 1200, totalToolUseCount: 1 });
    return yield* this.finish('The subagent located the greeting in `src/example.ts`.');
  }

  private async *webScenario(): AsyncGenerator<unknown, string> {
    const a = this.toolId(), b = this.toolId();
    yield* this.step([
      { type: 'tool_use', id: a, name: 'WebSearch', input: { query: 'vitest mock timers' } },
      { type: 'tool_use', id: b, name: 'WebFetch', input: { url: 'https://vitest.dev/guide/mocking', prompt: 'Summarize timers' } },
    ]);
    yield this.toolResult(a, 'Web search results for query: "vitest mock timers"\n\n[{"title":"Mocking | Guide | Vitest","url":"https://vitest.dev/guide/mocking"},{"title":"vi.useFakeTimers","url":"https://vitest.dev/api/vi"}]', false, {
      query: 'vitest mock timers', results: [{ tool_use_id: a, content: [{ title: 'Mocking | Guide | Vitest', url: 'https://vitest.dev/guide/mocking' }, { title: 'vi.useFakeTimers', url: 'https://vitest.dev/api/vi' }] }], durationSeconds: 1.2,
    });
    const r = await this.ask('WebFetch', { url: 'https://vitest.dev/guide/mocking', prompt: 'Summarize timers' }, b, { title: 'Claude wants to fetch vitest.dev' });
    yield this.toolResult(b, r.ok ? 'Use vi.useFakeTimers() to control time.' : r.message, !r.ok, r.ok ? { bytes: 4096, code: 200, codeText: 'OK', result: 'Use vi.useFakeTimers() to control time.', durationMs: 300, url: 'https://vitest.dev/guide/mocking' } : undefined);
    return yield* this.finish('Use `vi.useFakeTimers()` to control time in tests.');
  }

  private async *askScenario(): AsyncGenerator<unknown, string> {
    const id = this.toolId();
    const input = {
      questions: [
        { question: 'Which test runner should I use?', header: 'Runner', multiSelect: false, options: [{ label: 'vitest', description: 'Fast, Vite-native' }, { label: 'jest', description: 'The classic' }] },
        { question: 'Which checks should run?', header: 'Checks', multiSelect: true, options: [{ label: 'lint', description: 'ESLint' }, { label: 'types', description: 'tsc --noEmit' }, { label: 'e2e', description: 'Playwright' }] },
      ],
    };
    yield* this.step([{ type: 'text', text: 'I have a couple of questions first.' }, { type: 'tool_use', id, name: 'AskUserQuestion', input }]);
    const r = await this.ask('AskUserQuestion', input, id, { title: 'Claude has questions' });
    if (!r.ok) { yield this.toolResult(id, r.message, true); return yield* this.finish('Question was dismissed.'); }
    const answers = (r.input as { answers?: unknown }).answers ?? {};
    yield this.toolResult(id, `User has answered your questions: ${JSON.stringify(answers)}`, false, { questions: input.questions, answers });
    return yield* this.finish(`Thanks! Your answers: \`${JSON.stringify(answers)}\``);
  }

  private async *planScenario(): AsyncGenerator<unknown, string> {
    const id = this.toolId();
    const plan = '## Plan\n\n1. Add `farewell` export to `src/example.ts`\n2. Cover it with a unit test\n3. Run `npm test`\n\n**Risk:** low.';
    yield* this.step([{ type: 'thinking', thinking: 'I should present a plan for approval before editing anything.' }, { type: 'tool_use', id, name: 'ExitPlanMode', input: { plan } }]);
    const r = await this.ask('ExitPlanMode', { plan }, id, { title: 'Claude wants to exit plan mode' });
    if (!r.ok) { yield this.toolResult(id, r.message, true); return yield* this.finish('Plan rejected; staying in plan mode.'); }
    yield this.toolResult(id, 'User has approved your plan. You can now start coding.', false, { plan, isAgent: false });
    return yield* this.finish('Plan approved, starting work.');
  }

  private async *slowScenario(): AsyncGenerator<unknown, string> {
    const text = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    yield* this.step([{ type: 'text', text }]);
    return text;
  }

  private async *finish(text: string): AsyncGenerator<unknown, string> {
    yield* this.step([{ type: 'text', text }]);
    return text;
  }

  private async *demo(): AsyncGenerator<unknown, void> {
    // 1. thinking + todos
    const todoId = this.toolId();
    yield* this.step([
      { type: 'thinking', thinking: 'Let me break this down: read the code, make the edit, verify with tests, then summarize.' },
      { type: 'text', text: "I'll start by planning the work." },
      { type: 'tool_use', id: todoId, name: 'TodoWrite', input: { todos: this.todos(['in_progress', 'pending', 'pending']) } },
    ]);
    yield this.toolResult(todoId, 'Todos have been modified successfully.');
    // 2. exploration chips
    const [r1, r2, r3] = [this.toolId(), this.toolId(), this.toolId()];
    yield* this.step([
      { type: 'tool_use', id: r1, name: 'Read', input: { file_path: `${this.session.cwd}/src/example.ts` } },
      { type: 'tool_use', id: r2, name: 'Grep', input: { pattern: 'greeting', path: 'src' } },
      { type: 'tool_use', id: r3, name: 'Glob', input: { pattern: 'src/**/*.ts' } },
    ]);
    yield this.toolResult(r1, '     1\texport const greeting = "hello";\n', false, { type: 'text', file: { filePath: `${this.session.cwd}/src/example.ts`, content: 'export const greeting = "hello";\n', numLines: 1, startLine: 1, totalLines: 1 } });
    yield this.toolResult(r2, 'src/example.ts:1:export const greeting = "hello";');
    yield this.toolResult(r3, 'src/example.ts\nsrc/index.ts');
    // 3. subagent, bash, edit, write, web
    yield* this.taskScenario();
    yield* this.bashScenario();
    yield* this.editScenario();
    yield* this.writeScenario();
    yield* this.webScenario();
    // final todos + answer
    const t2 = this.toolId();
    yield* this.step([{ type: 'tool_use', id: t2, name: 'TodoWrite', input: { todos: this.todos(['completed', 'completed', 'completed']) } }]);
    yield this.toolResult(t2, 'Todos have been modified successfully.');
    yield* this.step([{ type: 'text', text: '## Summary\n\nEverything is done:\n\n| Step | Result |\n|---|---|\n| Edit | `src/example.ts` updated |\n| Tests | 20 passing |\n\n```diff\n- export const greeting = "hello";\n+ export const greeting = "hello, world";\n```\n' }]);
  }

  private resultMsg(subtype: string, text: string, start: number, isError = false) {
    return this.m({
      type: 'result', subtype, is_error: isError, duration_ms: Date.now() - start, duration_api_ms: Math.round((Date.now() - start) * 0.8),
      num_turns: this.num_turns, result: text, stop_reason: isError ? null : 'end_turn', total_cost_usd: 0.0123,
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 },
      modelUsage: { [this.model]: { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 8000, cacheCreationInputTokens: 500, webSearchRequests: 0, costUSD: 0.0123, contextWindow: 200000, maxOutputTokens: 32000 } },
      permission_denials: [], ...(isError ? { errors: [text] } : {}),
    });
  }

  private async *run(): AsyncGenerator<unknown, void> {
    let inited = false;
    for await (const um of this.params.prompt) {
      if (this.closed) return;
      this.aborted = false;
      if (this.abortCtl.signal.aborted) this.abortCtl = new AbortController();
      const start = Date.now();
      if (!inited) { inited = true; yield this.initMsg(); }
      const content = um.message.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content as unknown as Json[]);
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n');
      const images = blocks.filter((b) => b.type === 'image').length;
      const uuid = (um as { uuid?: string }).uuid ?? randomUUID();
      this.record('user', um.message, uuid);
      if (!this.session.title) this.session.title = text.slice(0, 60) || 'New session';
      yield { type: 'system', subtype: 'status', status: 'requesting', uuid: randomUUID(), session_id: this.sessionId };
      let out = '';
      let errored = false;
      try {
        out = yield* this.scenario(text, images);
        if (out === '__error__') { errored = true; out = 'Mock error: something went wrong (requested by prompt).'; }
      } catch (e) {
        if (!this.aborted) throw e;
      }
      if (this.closed) return;
      if (this.aborted) {
        yield this.resultMsg('error_during_execution', 'Interrupted by user', start, true);
        this.aborted = false;
      } else if (errored) yield this.resultMsg('error_during_execution', out, start, true);
      else yield this.resultMsg('success', out, start);
    }
  }
}

function chunkText(s: string): string[] {
  const out: string[] = [];
  const re = /\S+\s*|\s+/g;
  let m: RegExpExecArray | null;
  let buf = '';
  while ((m = re.exec(s))) {
    buf += m[0];
    if (buf.length >= 6) { out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  return out;
}

export function createMockAdapter(): SdkAdapter {
  const store = new Map<string, MockSession>();
  const info = (s: MockSession): SDKSessionInfo => ({ sessionId: s.id, summary: s.title || 'New session', lastModified: s.modified, customTitle: s.title || undefined, firstPrompt: s.title, cwd: s.cwd, gitBranch: 'main' });
  return {
    mock: true,
    query: (params) => new MockQuery(params, store),
    async listSessions(o) {
      let all = [...store.values()].filter((s) => s.messages.length > 0);
      if (o?.dir) all = all.filter((s) => s.cwd === o.dir);
      all.sort((a, b) => b.modified - a.modified);
      return all.slice(0, o?.limit ?? 500).map(info);
    },
    async getSessionMessages(id) {
      const s = store.get(id);
      if (!s) throw new Error(`Session ${id} not found`);
      return s.messages;
    },
    async renameSession(id, title) {
      const s = store.get(id);
      if (!s) throw new Error(`Session ${id} not found`);
      s.title = title;
    },
    async deleteSession(id) {
      if (!store.delete(id)) throw new Error(`Session ${id} not found`);
    },
  };
}
