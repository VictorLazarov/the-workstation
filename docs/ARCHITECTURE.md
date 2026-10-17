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
- Auth: random token generated at first start, stored `~/.config/workstation/config.json` (0600),
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

## Feature scope (parity target with Claude Code Desktop, phased)
P0 (baseline): chat w/ streaming markdown, tool-call cards (Bash/Read/Edit diff/Write/Grep/Glob/Web/Task/Todo), permission prompts, permission modes (default/acceptEdits/plan/bypass/auto), model + effort picker, thinking blocks, interrupt, slash commands & skills autocomplete, @file mentions, image paste/attach, session list/resume/rename/fork/delete, project (cwd) picker, todo panel, context usage meter, cost/usage, dark/light theme, settings (base URL, API key, defaults), keyboard shortcuts.
P1: file tree + file viewer, diff/changes panel with git status, checkpoints/rewind, integrated terminal, MCP server manager, subagent/background task panel, plan-mode review UI, git worktree sessions, notifications, hooks/CLAUDE.md editors.
P2: multi-session parallel tabs, Electron/Tauri wrapper, PWA.

## Quality gates
Typecheck + unit tests + Playwright e2e against a mock SDK (`WORKSTATION_MOCK=1`). Every PR-sized slice gets an independent reviewer pass.
