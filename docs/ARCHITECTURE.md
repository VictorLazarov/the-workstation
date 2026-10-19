# The Workstation — Architecture

A browser-based frontend for Claude Code, built on `@anthropic-ai/claude-agent-sdk`.
Runs as a local web server (`npx workstation` / `npm start`), opens at `http://localhost:7777`.
Installable into devcontainers via a Dev Container Feature (`devcontainer/`).

## Decision: build fresh, do not fork opencode
opencode (MIT) ships its own agent runtime, provider layer, session store and SolidJS UI bound to
its own SDK. Driving the Claude Agent SDK through it means replacing its entire backend and
remapping its message/permission model. We build a small purpose-built stack and borrow UX ideas.

## Layout (npm workspaces)
| Package | Role |
|---|---|
| `packages/protocol` | Shared TS types: client<->server WebSocket messages + REST shapes. **Single source of truth.** |
| `packages/server` | Node 22 HTTP+WS server. Wraps Agent SDK `query()`, session manager, REST (files/git/settings), serves built web UI. |
| `packages/web` | React + Vite + TS SPA. Claude-Code-like UX. |
| `devcontainer/` | Dev Container Feature + install script + docs. |

## Server <-> Web
- One WebSocket `/ws?token=…` per browser tab. Messages defined in `packages/protocol/src/index.ts`.
- REST under `/api/*` (bearer token header or `?token`). Static SPA at `/`.
- Auth: random token generated at first start, stored `<config dir>/config.json` (0600; `~/.config/workstation`, `%APPDATA%\workstation` on Windows, see CROSS_PLATFORM.md),
  printed as a URL on startup. Default bind `127.0.0.1`; `--host 0.0.0.0` (devcontainers) still requires the token.
  WS/REST check `Origin`/`Host` to block DNS-rebinding and cross-site WebSocket hijack. This is mandatory: the server can run shell commands.

## Agent SDK mapping
- One `query()` per live session, streaming-input mode (AsyncIterable of SDKUserMessage) so we can use
  `interrupt/setModel/setPermissionMode/rewindFiles/mcpServerStatus/...` mid-session.
- `includePartialMessages: true` → stream deltas to UI. SDK messages are forwarded raw inside `sdk` events (typed as unknown-ish in protocol) so new SDK message types don't need server changes.
- `canUseTool` → `permission_request` event; browser answers with `permission_response`. Also AskUserQuestion, ExitPlanMode go through it.
- History: `listSessions/getSessionMessages/renameSession/forkSession/deleteSession` from SDK.
- Settings sources: `AppConfig.settingSources` (default all of `['user','project','local']`, see "Config sources") so CLAUDE.md, skills, hooks, MCP and settings.json behave as in the CLI.
- Provider/base URL: UI settings → `options.env` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, model overrides). Only Anthropic-API-compatible endpoints / Claude models.
- Concurrent `session.start{resume}` of one id is serialized (map of in-flight starts): one CLI process, later callers
  attach. Live sessions are capped (`WORKSTATION_MAX_SESSIONS`, default 20).

## Credential isolation (custom endpoint / key / token)
Code: `packages/server/src/cli-env.ts`, tests `test/cli-env.test.ts` + `test/cli-isolation.test.ts` (real CLI against a
capture server).
- **No custom provider configured** (no base URL / API key / auth token in AppConfig): Claude Code runs exactly like the
  user's own `claude` (inherited env, `~/.claude`, normal login, `apiKeyHelper`). Nothing changes.
- **Custom provider configured**: nothing the server inherited may be used as a credential or reach that endpoint.
  1. *Environment*: inherited vars pass only through an allowlist for everything the CLI interprets: all `ANTHROPIC_*`,
     `CLAUDE*`, `CCR_*`, `SESSION_INGRESS*`, `WORKSTATION_*`, cloud-provider (`AWS_*`, `GOOGLE_*`, `CLOUDSDK_*`…), `OTEL_*`,
     `GIT_CONFIG_*`, `npm_config_*`, credential-looking names (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*AUTH*`, `*SESSION*`…) and
     proxies with `user:pass@` are dropped; `PATH`, `HOME`, locale, `TERM`, `SHELL`, `TMPDIR`, CA-bundle and credential-free
     proxy vars pass, as do ordinary toolchain vars (`JAVA_HOME`, `GOPATH`…) so the agent's tools work.
     `WORKSTATION_CLI_ENV=strict` passes only the base allowlist. AppConfig values (incl. `env`) are then added on purpose.
  2. *Config dir*: `CLAUDE_CONFIG_DIR=<WORKSTATION_HOME>/cli-home` (0700), rebuilt before each launch: symlinks to the user's
     `CLAUDE.md`, `skills`, `agents`, `commands`, `output-styles`, `plugins`, and `projects`/`file-history`/`todos`/`plans` (so
     the session list, resume and rewind keep working); a filtered copy of `settings.json` (no `apiKeyHelper`,
     `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, no credential `env`); and only the
     MCP/onboarding keys of `.claude.json`. `.credentials.json`, `remote/`, `*token*`/`*credential*`/`*key*` files are never
     linked and are deleted if they appear. A distinct `CLAUDE_CONFIG_DIR` also selects a distinct (empty) macOS keychain item.
  3. *No OAuth fallback*: the CLI reads hard-coded well-known credential files (e.g. `/home/claude/.claude/remote/.oauth_token`
     in Claude Code containers) whenever it has no explicit credential, regardless of `HOME`/`CLAUDE_CONFIG_DIR`. So without a
     configured key/token the CLI gets the non-secret sentinel `ANTHROPIC_API_KEY=workstation-no-credential`; the endpoint
     sees `x-api-key: workstation-no-credential` and never an inherited credential. Configure `apiKey`/`authToken` (or
     `env.ANTHROPIC_CUSTOM_HEADERS`) for gateways that need auth.
- Limits: project-level settings (`.claude/settings*.json` of the opened repo) still apply, as in the CLI. Managed/enterprise
  settings are not filtered. Bedrock/Vertex configured only via AppConfig `env` (no base URL/key/token) take the default
  path. The agent's own tools can still read files of the user (a third-party model drives a shell): isolation stops
  *automatic* credential forwarding, it does not sandbox the agent.

## Config sources and the loaded-configuration view
Code: `packages/protocol` (`SettingSourceId`, `resolveSettingSources`, `LoadedConfig`), `server/src/config.ts` (`settingSources()`),
`session-manager.ts` (start options, `loadedConfig`), `catalog.ts`, `permission-rules.ts`, `loaded-config.ts`; web `panels/LoadedConfig.tsx`,
Settings -> Config sources. Tests: `server/test/config-sources.test.ts`, `real-config-sources.test.ts` (`REAL_SDK=1`), `e2e/tests/app/config-sources.spec.ts`.
- **One setting, three consumers.** `AppConfig.settingSources` (unset = `user, project, local`; `[]` = SDK isolation) is passed as `options.settingSources`
  at session start, to the throwaway catalog probes (models / slash commands; the command cache is dropped when it changes and a live session only
  answers when it started with the same sources) and to the remembered-rules viewer (`GET /api/permission-rules` lists only enabled sources and
  reports `ignored` counts for the others). A session's value is fixed at start (`SessionRuntimeState.settingSources`); changing Settings applies to new
  sessions. The credential-isolated `cli-home` (custom endpoint) is independent: it only controls *where* the user source is read from.
- **Local off and "Always allow" (measured against the real SDK, haiku).** `settingSources` without `local` does NOT stop the CLI from writing an "Always
  allow" rule to `.claude/settings.local.json` (the suggestion still says `destination: localSettings` and the file is written), but the rule is not applied
  (an identical second call asks again) and a rule already in that file is not read. So persistence would be a silent lie: with Local off the server
  rewrites `remember: true` to a session-only rule (`destination: session`, which does work and writes nothing) and the UI shows "Allow for this session"
  instead of "Always allow". With Local on a rule is saved and applies immediately.
- **Loaded configuration** (`GET /api/sessions/:id/loaded-config`, Overview card): the SDK says what was loaded (init: skills, slash commands, agents,
  plugins, MCP servers with their scope; `getContextUsage().memoryFiles`; `mcpServerStatus`), and `loaded-config.ts` adds the origin by a read-only scan of
  fixed locations of the ENABLED sources (`CLAUDE.md` chain up to the project root, `CLAUDE.local.md`, `skills/*/SKILL.md`, `commands/**.md`, `agents/*.md`,
  the `hooks` key of the three settings files and of plugins' `hooks/hooks.json`). The SDK has no query call for hooks, hence the scan. Only names, paths and
  hook event / matcher / command are returned: never file bodies or env values; hook commands pass through `redactString` and are cut at 90 characters.
  Built-in skills / commands / agents are only counted. Hooks show a "run commands on your machine" badge with a link to Settings.
- **Mock.** The mock agent reads the same files (user dir from `CLAUDE_CONFIG_DIR` or `~/.claude`, project from the cwd) for its commands, skills,
  agents, plugins and memory files, honouring `settingSources`, so toggling a source changes what a new mock session lists. The e2e servers set
  `CLAUDE_CONFIG_DIR` to a throwaway dir: they never read the real `~/.claude`.
- Limits: managed/enterprise settings are not scanned (the SDK's own lists still include what they load); `@import`ed memory files and nested
  `CLAUDE.md` files below the cwd are only shown when the SDK reports them in `memoryFiles`; `/api/commands` for an already open session uses the current
  Settings, not that session's own sources.

## Using a gateway (LiteLLM/OpenRouter-style)
A custom `ANTHROPIC_BASE_URL` means the endpoint decides which model ids exist, so nothing may silently fall back to an Anthropic alias.
- **Session start**: `session.start` passes `model ?? defaultModel` to the SDK verbatim; with neither set nothing is passed (never `default`).
  The alias mapping lives in `AppConfig.env` and reaches the CLI through `ConfigStore.providerEnv()` (`ANTHROPIC_DEFAULT_SONNET|OPUS|HAIKU_MODEL`,
  `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`; the SDK typings do not list them, the bundled CLI binary does).
- **`gateway.ts`**: `GET <base>/v1/models` (`Catalog.gatewayModels`, cached 60 s, failures 15 s, silent) and `POST /api/gateway/test` (one
  `max_tokens: 1` message). Credentials exactly as sessions send them (`x-api-key` / `Authorization: Bearer` / the no-credential sentinel; never
  inherited ones), 4 s / 15 s timeouts, redirects followed only within the same origin, secrets scrubbed from every returned text. A saved key is
  only reused for the saved base URL's origin. Discovered ids come first in `/api/models` (`source: 'gateway'`).
- **model_not_found**: the server names the rejected id (from the CLI text, which may be a subagent/small-fast model, else the session's model),
  sends it as `error.model`; the web banner offers *Choose model* (set model + resend) and *Model settings* (Settings focused on Model).
- **Mock**: `WORKSTATION_MOCK_GATEWAY=1` makes the mock agent send one real request to the configured base URL and fail like the CLI on 404/401;
  `packages/e2e/support/fake-gateway.ts` is the fake gateway (unit: `server/test/gateway.test.ts`, e2e: `tests/app/gateway.spec.ts`).
  No real third-party gateway has been exercised.

## Browser client and the server origin
- The SPA talks only to the origin it was served from, with the `?token=` it was opened with (sessionStorage). `?server=`
  is ignored. A different server can only be set in Settings after a confirm dialog that names it and states that the token,
  keys, prompts and code will go there; it is stored as one `{origin, token}` record, so the same-origin token is never
  sent to it, and a banner shows the active remote server. Opening a `?token=` URL returns to the page's own server.
- The server accepts browser requests only from its own origin (Origin host:port = Host) or `WORKSTATION_ALLOWED_ORIGINS`.
- Served HTML carries a CSP (`script-src 'self'` + hashes of the inline theme script, `frame-ancestors 'none'`,
  `object-src 'none'`), `X-Frame-Options: DENY`, `nosniff`. REST bodies are capped at 2 MB, WS frames at 16 MB, 5xx
  responses are generic with a request id (details in the server log).
- `dangerouslySetInnerHTML` only ever receives Shiki output (escaped); pinned by `web/src/lib/html-sinks.test.ts`.

## Diagnostics log
Code: `packages/server/src/log.ts` (logger, ring buffer, rotating file), `redact.ts`, `sdk-log.ts` (SDK/CLI mapping), `diagnostics.ts`
(debug info); web: `panels/LogsPanel.tsx`, `panels/logs/LogsView.tsx`, `store/logs.ts`, `lib/logs.ts`.
- Entry = `{seq, ts, level debug|info|warn|error, source server|session|sdk|cli-stderr|permission|git|worktree|mcp|terminal|config|http, sessionId?, message, detail?}`.
  5000 entries in memory; `info`+ also appended to `<config dir>/logs/server.log` (0600, rotated at ~5 MB, 3 copies; `platform.logFileFor`).
- **Redaction happens when an entry is created**, so the buffer, file, REST answers and WebSocket stream are clean by construction:
  exact secret values the server knows (access token, `apiKey`, `authToken`, secret-named env values, also URL-encoded / JSON-escaped),
  credential shapes (`sk-ant-…`, `ghp_…`, JWT, AWS ids, private keys), `Authorization` / `x-api-key` / cookie headers, `?token=`-style
  query values, URL userinfo, `NAME=value` with a secret-looking name, and any detail field with a secret-looking name. Prompt/file
  content fields are replaced by their length. A session id taken from a client message must be a plain id that survives redaction.
  The download redacts once more. Tested in `test/log.test.ts` and `tests/app/logs.spec.ts` (fake key configured, secrets echoed).
- What is logged: server start/stop, config load/update (field names only), each WebSocket connect/disconnect (no token), session
  start/resume/fork/close, SDK errors (`api_retry`, error assistant messages, error results: code, HTTP status, provider message,
  `req_…` ids), CLI stderr lines, permission request/decision (tool name only), MCP status changes, git commit/revert and worktree
  create/remove (and failures), terminal start/exit, every REST 4xx/5xx (method, path, status; no query, body or headers), uncaught
  exceptions / unhandled rejections (then the process stops, as Node does by default).
- API (token-gated like all `/api`): `GET /api/logs` (since, level, source, sessionId, q, limit), `GET /api/logs/download`,
  `POST /api/logs/clear` (memory only), `GET /api/logs/debug-info`. Live stream: a socket sends `logs.subscribe`, then receives
  batched `log.entries`; nothing is sent to sockets that did not subscribe.
- UI: inspector **Logs** tab (red badge for errors that arrived while it was not on screen), a dialog when no session is open,
  palette "Open logs", Settings "View logs", "View details" on error banners and error toasts (opens Logs on that session at the
  entry nearest in time), Overview → Diagnostics → "Copy debug info".

## Terminal
The integrated terminal is the user's own shell: it keeps the user's dev credentials (`GH_TOKEN`, `SSH_AUTH_SOCK`…) and
drops only the server's own variables (`WORKSTATION_*`, `ANTHROPIC_*`, `CLAUDE_CODE_*`, anything containing the server
token). It runs as the same OS user as the server, so it **can** read `WORKSTATION_HOME/config.json` (server token, API
keys); the 0700/0600 modes protect against other users only. Do not treat the terminal as a sandbox.

## Git operations
Every git call runs with `GIT_LITERAL_PATHSPECS=1` (paths are never globs or `:(magic)`). Revert and commit require each
path to equal a current `git status` entry inside the repository (symlinked parents resolved, `.git` refused); `/api/git/diff`
serves only tracked or untracked-not-ignored files of the repo. Commit stages and commits exactly the files listed by the
Changes panel (`git commit -- <paths>`, other staged changes stay staged) and **runs the repository's hooks** (a failing
pre-commit hook is reported with its output). Read-only operations and revert run with hooks/fsmonitor disabled.

## Feature scope (parity target with Claude Code Desktop, phased)
P0 (baseline): chat w/ streaming markdown, tool-call cards (Bash/Read/Edit diff/Write/Grep/Glob/Web/Task/Todo), permission prompts, permission modes (default/acceptEdits/plan/bypass/auto), model + effort picker, thinking blocks, interrupt, slash commands & skills autocomplete, @file mentions, image paste/attach, session list/resume/rename/fork/delete, project (cwd) picker, todo panel, context usage meter, cost/usage, dark/light theme, settings (base URL, API key, defaults), keyboard shortcuts.
P1: file tree + file viewer, diff/changes panel with git status, checkpoints/rewind, integrated terminal, MCP server manager, subagent/background task panel, plan-mode review UI, git worktree sessions, notifications, hooks/CLAUDE.md editors.
P2: multi-session parallel tabs, Electron/Tauri wrapper, PWA.

## Quality gates
Typecheck + unit tests + Playwright e2e against a mock SDK (`WORKSTATION_MOCK=1`). Every PR-sized slice gets an independent reviewer pass.
