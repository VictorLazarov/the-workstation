# Scrutiniser pass 3: re-verification, visual matrix, real-SDK browser walkthrough (2026-10-17)

HEAD `c4f6066`, `npm run build` exit 0, no source edited. Scratch root `$S` =
`/tmp/claude-0/-home-user-the-workstation/ec6382e9-28d3-54c8-883c-b74c2a1383a3/scratchpad/s3/`
(screenshots: `$S/shots/` mock matrix, `$S/rshots/` real-SDK walkthrough; logs `$S/browser.log`).
Real-SDK model: `claude-haiku-5-5` (UI chip "Haiku 5.5"), about 15 tiny turns, total < $0.03.

## Verdict: FIX-THEN-ALPHA
All earlier BLOCKERs and MAJORs are fixed and verified independently. The real SDK works end to end (edit + permission, diff,
Changes, commit, Bash, plan approve, question, queue, restart + resume, fork, custom base URL, CSP). But the first real run
exposed two new MAJOR defects that the mock hides: every user Stop is shown as an error, and plan files outside the repo are
counted as project changes and break the inspector layout. Toast piles also cover content at narrow widths. Fix these three
(each is small) and ship the alpha.

## A. Verification of earlier findings (re-run by me against the current build)

### Security report (scrutiniser-1)
| ID | Result | Evidence |
|---|---|---|
| B1 `?server=` token exfil | VERIFIED-FIXED | Original `serverparam.mjs` repro: `localStorage ws.serverUrl = null`; evil server log shows only "listening", zero requests/upgrades. |
| M1 git revert pathspec | VERIFIED-FIXED | `path:"*"`, `src/[sl].ts`, `:(top)keep.txt` all return `file has no changes`; tree untouched (`keep.txt` modification intact). Re-ran `*` on the real repo too: no effect. |
| M2 creds to custom base URL | VERIFIED-FIXED | Real CLI via `capture.mjs`, fake HOME with `.credentials.json`, `ANTHROPIC_CUSTOM_HEADERS=X-Corp-Sso`, all CLAUDE*/CCR_/ANTHROPIC_* blanked, base URL set, no key: provider receives only `x-api-key: workstation-no-credential`; no `authorization`, no `x-corp-sso`. UI shows a helpful 401 message. |
| M3 concurrent resume | VERIFIED-FIXED | `robust.mjs`: two sockets resume the same id, one gets `session.started`, the other `ack`; after close `sessions: 0`. |
| M4 devcontainer | FIXED (read, not built) | `HOST` defaults to 127.0.0.1; repo is a real URL; Node comes from a sha256-verified nodejs.org tarball; CLI pinned 2.1.302; `VERSION=v0.1.0`. |
| MINOR 1 localhost:other-port Origin | VERIFIED-FIXED | `/ws` with `Origin: http://localhost:3000` gives 403. |
| MINOR 4 diff outside repo | VERIFIED-FIXED | `{"error":"path is outside the repository"}` |
| MINOR 6 config dir mode | VERIFIED-FIXED | dir 700, file 600. |
| MINOR 7 body limit | VERIFIED-FIXED | 3 MB POST gives 413. |
| MINOR 8 CSP/headers | VERIFIED-FIXED, see D | CSP + X-Frame-Options DENY + frame-ancestors none. |
| MINOR 9 raw 500 messages | PARTIAL | `/api/git/status?cwd=/nonexistent` gives `{"error":"not found"}` (generic). |
| Wrong/evil origin, Host rebinding | still OK | 403 for evil origin and evil Host. |

### Visual report (scrutiniser-2)
| ID | Result | Evidence |
|---|---|---|
| B1 popovers pinned to the left edge | VERIFIED-FIXED | Mode menu anchored above its chip at 1480/360 (`m-menu-mode--360-light-horizon-compact.png`, `rshots/13-mode-menu.png`). Lint `offscreen` = 0 in all 40 combos. |
| B2 toasts over composer | PARTIAL | Docked: toast sits in the sidebar column and clears the composer (lint `toast-overlap` = clear in 40/40). But toast stacks of up to 5 identical toasts cover content at 560/360 (see MAJOR N3). |
| B3 800/560 collapse | VERIFIED-FIXED | Sidebar becomes a drawer, inspector an overlay, no h-scroll (lint `page-overflow` = 0), composer usable at 360. |
| M1 empty plan editor | VERIFIED-FIXED | Plan "Edit" opens a seeded editor (`sc-plan-editing--1480-light-horizon-compact.png`); also approved a real plan end to end. |
| M2 wrong-token spinner | VERIFIED-FIXED | Dedicated "Access token missing or invalid" screen with steps and Retry (`shots/wrongtoken-800.png`). Nit: step 3 reads "Started it again, lost the link?". |
| M3 rewind wording | VERIFIED-FIXED | Dialog now says Bash/other-command changes are not restored (`rewind-dialog--...png`). |
| M4 stale Plan cards | VERIFIED-FIXED | Older snapshots collapse to "Updated plan 0/3 done"; one live card (`sc-todo--...png`). |
| M5 attention row looks selected | VERIFIED-FIXED | Selected row is the only filled row; waiting is a dot + "Needs input" pill. |
| M6 branch mismatch | VERIFIED-FIXED | Topbar, Environment and Changes agree in mock and real (`master`). |
| M7 split diff | VERIFIED-FIXED | Split is disabled at the 340 px inspector; at a wide inspector it renders both columns (`shots/split-wide-split.png`). |
| M8 stuck queued message | VERIFIED-FIXED | Item turns into "Not sent · Retry" (`shots/dbg-bash-800.png`). |
| MINOR 2 reload drops active session | FIXED | Reload restored the open session (real and mock). |
| MINOR 6 stop rendered as error | STILL-BROKEN, worse in real SDK | See MAJOR N1. Mock shows "Stopped" but the step is still red with a warning icon. |
| MINOR 5 error banner action | STILL | No Retry / Settings action. |
| MINOR 8 expand state kept | STILL | Thinking and tool-card expand state resets when you switch sessions (`func.mjs`). |
| MINOR 10 small targets | STILL | "Review" link 46x18 in write/edit card, "Task prompt" row 18 px, at 360 the `link-bt` is under 24 px. |
| MINOR 20 `−0` | PARTIAL | Created-file step fixed (`+3`); the Overview Changes card and Changes header still show red `+1 −0` / `+0 −0`. |
| MINOR 22 picker path | STILL | Breadcrumbs wrap to two lines; footer truncates the end of the path. |
| MINOR 25 `--cwd` first run | STILL | Real server started with `--cwd realrepo` shows "No projects yet" and the Welcome settings dialog (`rshots/01-home-firstrun.png`). |
| NIT Context "Mode: default", Files header "." | STILL | |

## B. Layout lint matrix
`layout-lint.mjs` over 12 states (home, draft, bash-perm, demo-done/top, mode menu, palette, settings + toast, Changes tab,
Context tab) for every combination of 1480/1100/800/560/360 x light/dark x horizon/warm x compact/comfortable = 40 combos
(about 400 linted states). Restarted the mock with `WORKSTATION_MAX_SESSIONS=500` because the cap of 20 live sessions (see N7)
blocks the matrix. Remaining `error` findings, aggregated:
- `Jump to latest` floating pill overlaps a tool-head line (22 hits, only when the view is scrolled to the top): NIT.
- 360 px: write-card "Review" link under 24 px, and the same pill overlap.
- 560/360 dark warm comfortable: stacked toasts overlap the Bash card, the "Allow/Deny" row and the draft suggestions (see N3).
- Zero `forbidden-hue` in Horizon, zero `offscreen`, zero `page-overflow`, zero contrast errors in the matrix. Single-state contrast
  errors from `full.mjs`: violet agent badge "Explore" 4.28:1 (needs 4.5).
- Console: no errors or failed requests except the deliberate server-down ones.
About 50 fresh screenshots were read (matrix + real walkthrough). Visual quality is now close to the reference: quiet sidebar,
overview cards with real numbers, one-line tool steps, slim composer with mode/model/effort below, plain prose, blue actions,
violet only on agent surfaces, SAP 72 font, no orange in Horizon.

## C. Real-SDK browser walkthrough (server without `WORKSTATION_MOCK`, temp `WORKSTATION_HOME`, scratch git repo)
Driven through a persistent Chromium (CDP) with a console/network logger. Screens: `$S/rshots/NN-*.png`.
| Step | Result |
|---|---|
| First run, Settings with model `claude-haiku-5-5`, Save, picker, open project | works; chip shows "Haiku 5.5" (`01`-`04`) |
| Prompt asking for an Edit | permission card with diff after 6.7 s, Allow once works, "Edited greet.ts +1 -1", file changed on disk (`06`-`07`) |
| Changes panel, Commit from UI | diff with shiki colours, commit toast `116d4c6`, panel shows "No changes" (`08`, `09`) |
| Bash with permission | card shows command, "Allow once", output box, "exit 0" (`10`-`12`). Detail line "Path: out.txt" under the title is odd but accurate (SDK blockedPath) |
| Plan mode + Approve plan | plan card renders, Approve works, mode returns to "Ask permissions", implementation edits followed with 3 permission prompts (`13`-`20`). See N2 for side effects |
| AskUserQuestion | card with options + Other, answer returned to the model (`21`, `22`) |
| Queue a second message while streaming | queued row shows, runs afterwards (`23`, `24`) |
| Interrupt a long turn | Stop works in 89 ms, BUT see N1 (`26`, `27`) |
| Context numbers | real (`4% 40.9k / 1M` for Haiku 5.5; breakdown changes per turn; Context tab shows cost, turns, loaded skills/tools). After a resume the usage cards start from 0 turns / $0.00 until the next turn |
| Kill + restart server, reload, click session, send a prompt | reconnect banner during outage, "Session ended (server shutdown)" notice, active session restored after reload, resume answered with history (`RECOVERED`), 5.5 s turn |
| Fork | "(fork)" row at top, conversation copied (`36`, `37`) |
| Custom base URL to a local fake endpoint (401) | request reaches the fake endpoint with only the sentinel key; UI line "API error 401: authentication_failed. Check the provider settings…" is good, but is followed by two wrong lines (N1) (`39`) |
| Wrong token | dedicated screen (mock, `wrongtoken-800.png`) |
Console during the real walkthrough: no errors other than the connection-refused ones while the server was down.

## D. CSP and residual security items (real browser)
- Header: `default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https: ws: wss:; frame-ancestors 'none'; object-src 'none'`.
  No CSP violations in the console. Shiki highlighting renders (Changes diff, Files preview `rshots/42-files-preview.png`,
  markdown code blocks). xterm renders and accepts input (`echo CSP-TERM-OK && ls` round trip, `rshots/41-terminal-typed.png`).
- Residual: `connect-src ... http: https:` allows connections to any host, so the CSP does not limit exfiltration after an XSS.
  It is needed only if a non-same-origin server is ever configured; today it can be `'self' ws: wss:`. MINOR.
- Markdown links/XSS were not re-fuzzed.

---

## BLOCKER
None.

## MAJOR

### N1. Every user Stop (and every API failure) shows "Something went wrong [ede_diagnostic] ..." and sets the session to Error
- **Repro (real SDK):** send "Write a very long essay ...", click Stop after 3 s. Result: "Interrupted by user" followed by a red
  banner "Something went wrong / [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null". Topbar status turns
  "Error", the sidebar row gets a red dot. Reproduced twice (once mid tool_use). The next prompt works and clears the status.
  With a bad base URL the same two extra lines appear after the real message "API error 401 ...": "Interrupted by user" (nobody
  interrupted anything) plus the diagnostic banner (`rshots/26-interrupted.png`, `27`, `39-baseurl-error.png`).
- **Expected:** Stop gives a neutral "Stopped" and an Idle session; failures show one clear message.
- **Cause:** `web/src/store/sessions.ts:~283`: `interrupted` is detected only if `result.errors` matches `/interrupt|abort/i`. The mock puts
  "Interrupted by user" in `errors`; the real SDK result is `error_during_execution` with `errors:["[ede_diagnostic] ..."]`.
  `lib/reducer.ts:246` also renders any `[Request interrupted by user…]` transcript line as "Interrupted by user".
- **Fix:** remember that the client sent `interrupt` for this turn (or the server's `task.stop`/interrupt flag) and treat the next
  error result as interrupted; hide `[ede_diagnostic]` details (log, don't show). Don't render the "Interrupted" line unless the user
  stopped. Make the mock return the real shape. Regression: a real-SDK e2e (gated) or a reducer unit test fed the real payload above.

### N2. Plan files from `~/.claude/plans` are treated as project outputs and Changes, and they break the inspector layout
- **Repro (real SDK):** plan mode, send a prompt, let the agent write its plan file. The conversation shows
  "Created …laude/plans/plan-do-not-edit-lexical-quill.md +5". Overview then lists it under Outputs with the path
  "/root/.claude/plans" clipped at the right edge (a stray "n" is cut off). The inspector gets a horizontal scrollbar. The Changes card says
  "2 files +6 −0" and the Changes tab shows "All changes 2 / This session 1" with the plan file as an "A" entry, while the footer says
  "Stages and commits these 1 file". After the implementation: "3 files +10 −0" although the repo has 2 files and +5 lines.
  Shots: `rshots/15-plan-card.png`, `16-changes-after-plan.png`, `20-plan-implemented.png`.
- **Expected:** only files inside the session's checkout appear in Outputs/Changes counts; counts equal what Commit will stage; long
  paths ellipsize in the middle.
- **Fix:** filter transcript-derived changes to paths under `cwd`/worktree (or show external files in a separate muted group);
  make the header count come from the same list as the Commit button; ellipsize `.ov-item` paths; clarify the "All changes / This session"
  switch, or drop it. Regression: layout-lint on an Outputs row with a 60-char absolute path; unit test for path filtering.

### N3. Toast pile covers content at narrow widths (and stacks duplicates)
- **Repro (mock, 560 and 360 px):** let several background sessions finish. Five identical "Session finished / bash please: Ready for
  your review" toasts stack top-right and cover the permission buttons ("Always allow"/"Deny…"), the draft suggestions and tool cards. At
  1480 the same pile covers about 400 px of the sidebar list (`shots/appearance--1480-light-horizon-compact.png`) and sits above the
  Appearance popover, hiding its left part.
- **Why it matters:** the owner complained about toasts covering the UI before; with parallel agents this happens routinely. Lint
  `overlap` fails in 8 of the 40 matrix states.
- **Fix:** coalesce into one toast ("3 sessions finished"), cap visible toasts at 2, auto-dismiss notifications for sessions that are
  not active after about 5 s, keep them off the permission/composer area at narrow widths, put popovers above toasts.
  Regression: lint with 5 queued toasts at 560/360.

## MINOR
1. **Sidebar title changes after a server restart/reload.** Live title "In greet.ts change..." (first prompt), after reload
   "Reply with the single word: RECOVERE..." (latest prompt). Titles should be stable (`rshots/31` vs `32`).
2. **Usage resets after resume:** Context tab shows "$0.00, 0 turns" and the topbar loses its cost until the next turn.
3. **Stop in the mock still renders a red step with a warning icon** next to "Stopped" (`sc-interrupted--...png`). Make the step neutral.
4. **Error banner has no action** (Retry / Open settings) - e.g. 401 should link to Settings.
5. **The 20-live-session cap** error is shown as a raw toast "too many live sessions (max 20); close one first or raise
   WORKSTATION_MAX_SESSIONS" (`shots/dbg-bash-800.png`): jargon, and there is no UI to close idle live sessions. Open sessions of a
   closed tab stay live (the matrix hit 20 within minutes).
6. **First run ignores `--cwd`:** "No projects yet" plus a Welcome settings dialog that stays titled "Welcome" for a signed-in user
   (`rshots/01`). Offer "Open realrepo" in one click.
7. **Changes header shows "0 files +0 −0"** and the Overview Changes card keeps a red `−0` (`rshots/09-committed.png`).
8. **Small targets still present** (Review link 46x18, Task prompt row 18 px) and violet "Explore" badge contrast 4.28:1.
9. **Expand state lost on session switch** (thinking and tool cards).
10. **CSP `connect-src` allows any http(s)/ws host** (see D).
11. **Project picker:** wrapped breadcrumbs, end-truncated footer path.
12. **Sidebar row hover overlaps the "..." button** (lint `overlap`; intended hover swap, but make it non-overlapping).
13. **Toast over the sidebar bottom covers real session rows** when many toasts stack, see N3.

## NIT
- Token screen step 3 grammar ("Started it again, lost the link?"), violet shield icon on a non-agent screen.
- Bash permission card shows "Path: out.txt" as a detail line for a redirect.
- Context tab "Mode: default" raw id; Files preview header "." for root files; `--` Overview "Changes" `+1 −0` red zero.
- AskUserQuestion card uses the shield (permission) icon.
- The "Jump to latest" pill overlaps a tool line when the view is at the top of a long session.
- Mock fidelity: mock interrupt/error payloads differ from the real SDK (hid N1), mock Edit/Write do not touch disk.
- Terminal font renders heavier than the app's mono (cosmetic).

## What I did not test
- Windows/macOS, Firefox/Safari, Electron, a real devcontainer/Docker build (M4 verified by reading `install.sh` only).
- Real Bash "Always allow" persistence, worktree sessions with the real SDK, MCP servers, subagent (Task) runs, rewind execution, images,
  a 20 MB paste, IME/RTL, touch, a screen reader.
- Opus/Sonnet models and extended-thinking display; only Haiku 5.5 with tiny prompts.
- Stress with many parallel real sessions (cap at 20 observed in the mock only).
- The e2e suite and unit suites were not re-run (by instruction); the lint matrix replaces them.
- Markdown/tool-output XSS fuzzing beyond the earlier pass; the `workstation-url` token printing behaviour of the devcontainer.
