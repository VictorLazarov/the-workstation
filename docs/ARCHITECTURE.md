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
- Settings sources: `['user','project','local']` so CLAUDE.md, skills, hooks, MCP and settings.json behave as in the CLI.
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
