# Scrutiniser pass 4: stable-alpha check (2026-10-18)

HEAD `621e078`, `npm run build` exit 0, no source edited, nothing committed. Scratch root `$S` =
`/tmp/claude-0/-home-user-the-workstation/ec6382e9-28d3-54c8-883c-b74c2a1383a3/scratchpad/scrut4/`
(screenshots `$S/shots/`; mock server on :7791 with a temp `WORKSTATION_HOME`, real-SDK servers on :7792/:7794, all stopped by PID).
Real SDK: `claude-haiku-5-5` only, about 12 tiny turns (total well under $0.10). Tests re-run: `npm test` = 142 server + 137 web unit
tests pass (21 real-SDK tests skipped); `scripts/test-feature.sh` PASS; `shellcheck -S warning` on the installers is clean.
Layout lint (`packages/e2e/support/layout-lint.ts`) run by me over 8 states/tab x 1480/1100/800/560 x light/dark x horizon/warm
(16 combos, about 190 linted states): zero contrast / forbidden-hue / page-overflow / no-name / small-target errors, zero console errors.

## Verdict: FIX-THEN-ALPHA (close)
Core flows work and look right: first run, sessions, every mock keyword, permissions + Always allow (real SDK: rule persists, "Forget"
really takes effect in the running session), Stop (neutral "Stopped", Idle, real SDK too), plan edit/approve, AskUserQuestion, queueing,
Changes + commit + revert, diff comments (sent as one prompt), rewind menu with honest limits, worktree toggle + Remove worktree, MCP
toggles, Tasks panel with a working per-task Stop (real subagent stopped), offline banner with "Not sent / Retry", resume, command
palette, XSS probes. Security is where it should be. But an owner will hit three things within the first hour: a new directory created by
the agent cannot be reviewed (infinite "Loading diff..."), one long "Always allow" rule breaks the whole Settings dialog, and the most
common first failure (bad key) prints the same error three times. Fix those (each small), then it is a stable alpha.

## Fix first (MAJOR)

### M1. Untracked directory in Changes: endless "Loading diff...", wrong counts, misleading delete error
- **Repro (mock and real SDK, both reproduced):** the agent creates `src/lib/util.ts` in a repo that has no `src/` yet (or any new folder).
  `git status --untracked-files=normal` reports one entry `src/`. Changes tab shows a card "U src" whose body is a spinner "Loading diff..."
  forever. Header says "2 files" (a directory counts as a file), the Overview card counts it, Commit stages it (works, `gitCommit` accepts
  `dir/`), so the owner commits files they could never review. Clicking the card's "Delete file..." and confirming gives the toast
  "Could not revert: file has no changes" (server refuses directories with 409/400). Shots: `shots/11-changes.png`, `13-revert-dir-result.png`,
  real: `shots/r03-changes.png`.
- **Cause:** `web/src/panels/changes/store.ts:~34` deliberately skips diffs for entries ending in `/`; `ChangesPanel.tsx:58` treats
  `added === undefined` as "still loading"; `canRevert` is true for it (`:197`).
- **Fix:** expand untracked dirs (ask status with `--untracked-files=all`, or `git ls-files --others --exclude-standard -- dir/`) so each file
  gets its own card, capped (e.g. 40, "and N more"); never show the spinner once the load finished; hide revert for directory entries (or
  implement "delete folder" with a strong confirm). Regression: derive/store unit test with a `src/` status entry + e2e with a created folder.

### M2. A long remembered rule breaks the Settings dialog (horizontal scroll, controls pushed off-screen)
- **Repro:** project has `.claude/settings.local.json` with `Bash(git commit -m "a really long message ...":*)` (normal after "Always
  allow" on a long command). Open Settings (Ctrl+,). `.dialog-body` scrollWidth 1008 vs clientWidth 558: the whole dialog scrolls sideways,
  Theme/Brand/Density segmented controls, the Forget buttons, Server URL field and "Auth token" are cut off at 1480, 1100, 800 and 560
  (lint `offscreen` x 14 states). Shots: `shots/45-settings-rules-1480.png`, `43-settings-rules.png`, `lint-settings-560-dark-warm.png`.
- **Cause:** `.rules-list { display: grid }` (`panels/panels.css:196`) has an auto track, so the row's min-content (the no-wrap `code`) sizes the
  track even though `.rule-text` has `min-width:0; text-overflow: ellipsis`.
- **Fix:** `grid-template-columns: minmax(0, 1fr)` (or `display:flex; flex-direction:column`). Regression: layout-lint on Settings with a 300-char rule.

### M3. One bad API key shows the same error three times, with CLI jargon
- **Repro (real SDK, fake 401 endpoint in Settings):** send "hello". Conversation shows (1) red banner "Invalid API key · Fix external API key"
  + Open Settings, (2) the same sentence again as assistant prose, (3) a second red alert "Authentication failed. Check your API key in
  Settings." Topbar "Error". Shot `shots/r40-401-10000.png`. "external API key" is Claude Code CLI wording and wrong here (the key came from
  Settings). The mock 401 additionally leaves a stale "API 401, retrying (attempt 1/10)" yellow card with a spinner under the error
  (`shots/10-401.png`), and the mock `error` scenario prints its message twice joined by `;` (`shots/09-error.png`).
- **Cause:** `reducer.ts addTurnError` notice + the CLI's synthetic assistant message (rendered as text) + the `error` row from
  `tools.ts humanizeError` for `assistant.error`.
- **Fix:** when a turn error notice exists, drop the synthetic assistant error message and the `humanizeError` row; clear `retry` state on
  failure; dedupe the joined `errors[]`. Regression: reducer test fed the real captured sequence (assistant message with `error:
  authentication_failed` + `error` event + error result) expecting exactly one notice.

## MINOR
1. **Long unbreakable token in assistant prose scrolls the whole conversation sideways** (URL/hash > pane width): `.conv-scroll` scrollWidth 1505 vs 874,
   the paragraph runs under the edge (`shots/72-longprose.png`, `70-long.png` at 800). User bubbles wrap, assistant `.md p` does not. Fix:
   `overflow-wrap:anywhere` on `.md`.
2. **Stale 404 after Remove worktree:** the Changes poll hits `/api/git/status?cwd=<removed worktree>` -> 404 + a console error (`b4.mjs` log). Stop
   polling once `wtRemoved`.
3. **Sessions that need input can hide behind "Show N more"** (first 6 by recency only, `Sidebar.tsx:~170`); the project badge counts them but the row
   is hidden. Pin needs-input/running rows first. In the mock, live worktree sessions disappear from the list after reload
   (`mock.ts listSessions` filters `cwd === dir`, and `app.ts:154` only adds live sessions whose cwd equals the project): real SDK includes worktrees, mock does not.
4. **Persistent toasts:** "Approval needed +6 more" / "Plan ready for review" never auto-dismiss and, at 560/800, sit over the top of the conversation
   (`shots/lint-demo-560-dark-warm.png`); they also survive a server outage (stale approvals while offline, `shots/61-offline-send.png`).
5. **Diff comments are in memory only** (lost on reload) and a sent review is shown as plain text (`- line 1 (...)` not rendered as a list). Acceptable for alpha; say so.
6. **Mock fidelity:** "Always allow" does not persist or apply in the mock (second `bash` asks again), mock Edit/Write never touch disk (Outputs
   shows files, Changes says clean). Verified the real behaviour with the real SDK instead (below), but demos/e2e hide bugs like M1.
7. **Topbar at 560** drops the session title and the Idle/Working status; at <=800 the only status cue is the sidebar.
8. **Markdown link with a stripped href** (`[a](javascript:...)` becomes `href=""`) still renders as a link with `target=_blank`; clicking opens a second tab of the app. Render as plain text instead.
9. Carried from pass 3 and still open: Context tab "Mode: default" raw id; hover swap overlaps the row "..." button (lint overlap x 7); project picker footer path breaks mid-word.

## NIT
- Tasks panel card repeats the description twice ("Run sleep 60 and report" x2), `shots/r32-after-stop.png`.
- Welcome/first-run Settings has a large empty gap above/below "Remembered permissions" when there are no rules (`shots/01-firstrun.png`).
- "Default (recommended)" and "Sonnet" both read "Sonnet 5.5" in the model menu (accurate, redundant).
- Bash permission card detail "Path: out.txt" for a redirect (pass 3 nit, unchanged).

## Verified OK this pass (evidence)
- **Pass 3 majors:** N1 Stop is neutral and the session goes Idle in mock and real (`shots/08-slow-stopped.png`, `r14-stopped.png`); N2 plan file under
  `~/.claude/plans` is an Output tagged "Plan file", not a Change; N3 toasts coalesce ("Approval needed +6 more") and sit in the sidebar column when docked.
- **New features:** worktree toggle (menu, branch `workstation/<id>`, Checkout "Worktree", path ellipsized in the middle, Remove dialog states what is deleted,
  after removal "Session ended (worktree removed)", composer read-only, `git worktree list` clean); MCP toggles in Overview and Context; Tasks panel + Stop
  (real subagent: card "Stopped", agent reacted); rewind menu with disabled reasons and the "Not restored: Bash..." note; remembered-rules viewer (list, Forget
  confirm, real file edited atomically to `{}`, mode 600, other keys kept); line comments (click +, Ctrl+Enter, delete, Send to agent batches into one prompt);
  actionable error banner with "Open Settings"/"Retry"; model chip labels ("Haiku 5.5").
- **Real SDK:** Bash + Always allow wrote `Bash(touch f1.txt)`, same command no longer asks, after Forget it asks again in the same live session; Stop; subagent Stop;
  project settings `env.ANTHROPIC_BASE_URL` in an untrusted repo did NOT redirect the request (fake endpoint saw zero requests).
- **Security:** no token / `?token=` query on REST -> 401; evil Origin, `localhost:3000` Origin, evil Host -> 403; WS and `/ws/terminal` without token 401, evil origin 403;
  `/api/permission-rules` DELETE validates behavior/rule/cwd (`__proto__` -> 400); `GET /api/config` redacted; markdown/HTML probes
  (`javascript:`, `data:`, `<img onerror>`, `<script>`, `vbscript:`) produce no live element, no dialog; the only `dangerouslySetInnerHTML` sinks are the four Shiki consumers (test passes).
  Residual: CSP `connect-src` still `http: https: ws: wss:` (pass 3 D), `/api/fs/*` and `/api/permission-rules?cwd=` accept any directory for a token holder (acceptable: the token is shell access).
- **Break it:** 3 MB paste fills in 1 s and sends; triple Enter sends once; RTL/long path wraps in the user bubble; offline: banner "Connection lost. Reconnecting... Retry now",
  typed message "Not sent · Retry", after restart the session resumes and answers.

## What I did not test
Windows/macOS, Firefox/Safari, Electron, a real Docker build (no daemon here; `Dockerfile`/`docker-compose.yml` read only, installer smoke test passes), MCP servers with a
real failure state, real worktree sessions with the SDK, rewind execution with the real SDK, images, the real `/api/sessions` list with worktrees, a screen reader,
500-message conversations, touch/IME, compact vs comfortable at every width (comfortable only with the warm brand in the lint matrix), the full e2e suite (not re-run; lint script reused instead).
