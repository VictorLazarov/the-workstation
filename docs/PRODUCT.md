# The Workstation — Product Brief

> Read this first. It explains what we are building, why, the principles that decide trade-offs, what is
> deliberately *not* in scope, and where the product should go next. Supporting docs are listed at the end.
> Last updated: 2026-10-18 (post scrutiniser pass 5; see "Current state").

## 1. What it is
**The Workstation** is a personal, desktop-style workspace for coding agents. It runs as a local web app
(open `http://localhost:7777` in a browser), installs into devcontainers, and is designed to be wrapped in
Electron/Tauri later. Under the hood it drives the **Claude Agent SDK**; everything the user sees — sessions,
diffs, permissions, plans, terminals, panels — is our UX/UI on top of it.

It belongs to the same family as Claude Code Desktop, Cursor's Agents window and the GitHub Copilot app:
a *graphical agent workspace*, not a terminal transcript in a browser.

## 2. Why it exists
The owner wants a coding-agent tool they can **shape around their own daily work**, instead of settling for
the UX of existing tools (including opencode's), and that can be pointed at **their own provider/gateway**
(`ANTHROPIC_BASE_URL`). Ownership is the point: when a workflow is missing, we add it.

The owner's one-line version: *"best-in-class engine, my UX."*

## 3. Who it is for
- Primary user: the owner — a working developer running several agent tasks in parallel on real repos,
  locally and inside devcontainers.
- Secondary: teammates who might later want the same tool. Single-user and local-first today; multi-user,
  hosted, or team features are **not** goals until the owner says so.

## 4. Principles (use these to settle arguments)
1. **The SDK is the engine; we do not reinvent it.** Agent loop, tools, permissions, sessions, resume/fork,
   checkpoints/rewind, MCP, skills, subagents, hooks, settings sources, usage — all SDK. Before building any
   feature, check whether the SDK already provides it and expose it instead. Our value is UX and workflows.
2. **A workspace, not a CLI.** Desktop-app patterns: project/session sidebar with live status, rich tool cards
   (diffs, command output, plans — never raw JSON), review panes, inline approvals. See `UX.md`.
3. **Parallel agents are first-class.** Many sessions run at once, each optionally in its own git worktree;
   the sidebar says which one needs you.
4. **Review is the product.** The time a developer spends is reviewing and steering. Diff review, line
   comments, rewind, plan approval and honest cost/context visibility matter more than chat polish.
5. **Honest UI.** Show real state and real limits (e.g. rewind does not track Bash edits; context category split
   is an estimate). No dead buttons: if a feature is not built, hide it. No hidden costs.
6. **Safe by default.** The server can run shell commands as the user. Token on every request, strict
   Host/Origin checks, localhost bind by default, secrets never echoed or leaked to a custom provider.
7. **Portable by construction.** The UI talks to the server only via `/api` + `/ws` and reaches native features
   through a `platform` adapter, so Electron/Tauri is a thin shell. See `VISION.md`.
8. **Extensible at the UI layer.** Panels, tool-card renderers and commands are registries so the owner can add
   personal workflows quickly.
9. **Taste matters.** Calm, dense, polished. Brand hints come from SAP's Horizon language (72 typeface, Horizon
   blues/neutrals, violet reserved for AI surfaces). See `BRAND.md`.

## 5. Explicit non-goals (for now)
- Our own agent runtime, tool implementations, or model-provider layer. (Providers = Anthropic-API-compatible
  endpoints/gateways only, because that is what the SDK supports.)
- Forking opencode. Evaluated and rejected: its UI is bound to its own runtime, SDK and ~40-package monorepo.
- Multi-user accounts, cloud hosting, billing, sync.
- Presenting this as "Claude Code" or offering claude.ai login / its rate limits — the SDK terms forbid it.
  Our name is "The Workstation"; copy says "built on the Claude Agent SDK".
- Copying any competitor pixel-for-pixel or using SAP logos/wordmarks.

## 6. Architecture in one paragraph
npm-workspaces monorepo. `packages/server` (Node, hono + ws) hosts one SDK `query()` per live session,
bridges permissions/questions to the browser, exposes REST for files/git/search/config/worktrees and a
token-gated PTY terminal socket, and serves the built SPA. `packages/web` (React + Vite + zustand) folds raw SDK
events into conversation state and renders them; panels register themselves. `packages/protocol` holds the
shared wire types. `devcontainer/` has a Dev Container Feature + installer. A mock SDK (`WORKSTATION_MOCK=1`)
drives demos and e2e tests (`WORKSTATION_MOCK_FS=1` makes its Edit/Write touch the disk and persists "Always allow"; the e2e `fs` project uses it). Details: `ARCHITECTURE.md`.

## 7. Current state (honest snapshot, 2026-10-18, after scrutiniser pass 5 and its fixes)
Verdict of the last independent pass (`reviews/2026-10-scrutiniser-5.md`): FIX-THEN-ALPHA, and its majors are fixed in HEAD (root
bypass, worktree removal, removed-worktree sessions, README quickstart). The owner can start daily work on a non-root machine.

**Built and verified against the real SDK (browser UI, `REAL_SDK=1` specs `packages/e2e/tests/live/real-*.spec.ts`, `packages/server/test/real-alpha.test.ts`, plus
three manual scrutiniser trials with real turns):** the daily loop (multi-file feature with @file mentions, diff review, a line comment sent back and
fixed, rewind, commit, two parallel worktree sessions, terminal, queueing, Stop, reload mid-turn, server restart + resume); permissions
incl. "Always allow" persisted and applied; AskUserQuestion; plan mode; model/mode/effort; images; MCP servers (connected and failing,
with the real error); subagents (Task card, Tasks panel, Stop); worktree sessions (new-session toggle, Changes + commit in the worktree,
remove with a discard confirm that can be cancelled without side effects, a removed worktree's session stays listed after reload); rewind
(code / conversation / both, with what it cannot restore); five parallel sessions; switching to Sonnet mid-session; line comments batched into one prompt;
remembered-rules viewer in Settings; error banners with Open Settings (a rejected key shows one banner, not a retry loop).
**Built and verified on the mock, Linux, Chromium (`npm test`, `npm run test:e2e`: projects `app`, `live` at 0.25x speed, `fs`; layout-lint gate
for overlap/contrast/overflow across 16 theme/density/width combinations):** the web shell, conversation and tool cards, inspector panels
(Overview with Context/Environment/Outputs/Tasks, Plan, Changes with diff + commit + revert + new-folder files, Files, Tasks, Terminal),
settings incl. custom base URL/key and appearance, token screen, Host/Origin checks, offline queue.
**Verified in real containers (`scripts/test-devcontainer.sh`, authoring sandbox, see `DEVCONTAINER.md` "What is verified"):** the Feature on
Ubuntu and a Node base image, the Dockerfile and compose (non-root, arbitrary uid, volume persistence), loopback vs `0.0.0.0` with a
published port, tokenized URL, WS auth, a mock-mode session, worktrees and the PTY. A fresh clone builds with `npm ci` + `npm run build`
and `npm audit --omit=dev` reports 0 vulnerabilities.
**Verified only on mock and/or Linux:** everything about Windows and macOS (the CI matrix `node (<os>, node 20|22)` and the smoke jobs exist and the
first-CI-run failures were fixed, but those runners are advisory and the PTY/real-CLI suites have not been shown green there), Firefox and WebKit
(`e2e-firefox|webkit` are advisory, `browserslist` + a compat test guard the CSS/JS features, no real-world use), and the Docker/devcontainer paths
that the sandbox could not reach (Alpine, `git-debian`, base-image `apt` steps).

**Known gaps (not yet closed):**
- Windows, macOS, Firefox and Safari have had no real-world use beyond CI; Electron/Tauri shell not started.
- The Dev Container Feature is not published to GHCR and the release tag `v0.1.0` does not exist: both are the owner's action
  (`DEVCONTAINER.md` "Release"). Until then installer/Feature must name a branch or full commit SHA; the README says so. `source=npm` is unpublished.
- A third-party Anthropic-compatible gateway has never been tested end to end. Gateway support (model discovery, Test connection, alias mapping, a banner that names the rejected model and offers a picker) is built and verified only against a local fake gateway (`packages/e2e/support/fake-gateway.ts`); real LiteLLM/OpenRouter behaviour (listing shapes, small-fast/subagent models) is unverified.
- The access token travels in the `?token=` query string of the first URL (it lands in history/referrers if pasted; the SPA strips it after load).
- GitHub Actions in `.github/workflows` are tagged, not pinned to commit SHAs.
- The CSP keeps `connect-src` open (`http: https: ws: wss:`) because the user can confirm another server in Settings; a stricter policy needs a server-side allow-list.
- The licence of the bundled 72 typeface is unconfirmed: `THIRD_PARTY_NOTICES.md` records Apache-2.0 from the npm package metadata, but nobody has confirmed with SAP that the font files themselves carry it; confirm before any public distribution.
- Not exercised: Codespaces/VS Code Dev Containers, Docker Desktop on macOS/Windows, rootless Docker/Podman, arm64, a machine with no credentials at all,
  a 40+ file new folder (cap), 500-message conversations, screen readers, touch/IME, no virtualization for very long conversations.
- Product limits we state in the UI: a rewound conversation is a new session (the original stays); rewind does not restore Bash or subagent edits;
  "Always allow" rules of a worktree session are saved by the SDK in the MAIN checkout's `.claude/settings.local.json` (they outlive the worktree);
  line comments in split diffs are listed under the diff, not between its rows and live in this browser's localStorage; Cursor/Copilot research is from search snippets only.
- Open minors from pass 5 (see the report): narrow-inspector diff clipping, doubled ellipsis in toasts, a stale "Not connected" toast after reconnect,
  hover-swap overlapping the sidebar row's "..." button, worktree sessions' first `cd` flagged by the SDK, long first-run Settings without a scroll cue.

## 8. Roadmap (priority order)
**Next (wave 3)** — drawn from `RESEARCH.md`. Delivered and removed from this list: worktree toggle, diff line comments, rewind menu,
remembered-rules viewer, error banners.
1. Editable plan with Approve / Build; side chat that never writes to the thread.
2. Sidebar filters (status/project), auto-archive, notifications when a session needs input or finishes.
3. Horizon brand pass (in progress) with a warm/horizon switch.
4. Electron shell (`apps/desktop`, a few hundred lines): embed `startServer()` on a free port with a
   generated token, native menus, folder dialog via the `platform` adapter.
**Before calling it stable / sharing it (hardening, owner actions first):** push tag `v0.1.0` and run the Feature publish, then smoke-test from GHCR;
turn the advisory Windows/macOS/Firefox/WebKit CI jobs into required ones once green; try a real third-party gateway; move the token out of the
URL (one-time code exchanged for a cookie or header); SHA-pin the Actions; tighten `connect-src`; confirm the 72 font licence.
**Later:** PR/CI bar (fix-CI, address comments; any auto-merge strictly opt-in), preview pane with per-project
launch config, "My Work" home from issues/PRs, task chips that spawn sessions, PWA, conversation virtualization.

## 9. How we build (team process)
Work is split by package/directory so agents never collide; a lead integrates and commits. Every slice gets
typecheck + unit tests + a browser check against the mock server, and risky areas (security, SDK glue) get an
independent review before release. Use cheaper models for simple implementation, stronger ones for the server
core, architecture and reviews. Verify claims yourself — agent reports are leads, not proof.

## 10. Decision log
| Decision | Why |
|---|---|
| Build fresh, don't fork opencode | Its UI/runtime are coupled; replacing its backend ≈ rewrite |
| Claude Agent SDK as the only engine | Best-in-class loop/tools/permissions; no reinventing |
| Web app first, Electron later | Same code runs in browser, devcontainer, and desktop shell |
| Token + Host/Origin checks everywhere | Server executes commands; DNS-rebinding/CSWSH must be blocked |
| Model/effort/mode live in the composer only | Per-message settings belong next to input; no duplicate controls |
| Strip inherited credentials when a custom base URL is set | Found in testing: they were being sent to the custom endpoint |
| Violet only for AI surfaces, blue for actions | Semantic colour: users learn "purple = the agent" |
| Hide unbuilt features | Honest UI; no dead buttons |
| Offer "Bypass permissions" only when it can work (not root unless `IS_SANDBOX=1`, not if `WORKSTATION_ALLOW_BYPASS=0`) | Pass 5: as root every real session died with a cryptic CLI error; the mode is shown disabled with the reason instead |
| The mock touches the disk only with `WORKSTATION_MOCK_FS=1` | Honest mock for Changes/commit/"Always allow" flows (e2e `fs` project, screenshots) while shared fixtures and demos are never modified by default |
| Rewind states what it cannot restore and previews the dry run | Bash and subagent edits are not tracked by the SDK; conversation rewind forks a new session, the original stays |
| Remove-worktree checks for uncommitted changes before closing the session | Cancelling the discard prompt must not end a live session; a removed worktree's session stays listed and readable |

## 11. Related documents
`VISION.md` (owner's intent, portability rules) · `UX.md` (binding UX principles) · `ARCHITECTURE.md`
(system design) · `RESEARCH.md` (competitor findings, with source caveats) · `BRAND.md` (visual language) ·
`DEVCONTAINER.md` (install) · `../README.md` (quickstart).
