# Scrutiniser pass 5: verification + daily-use trial (2026-10-18)

HEAD `eff7a84`. No source edited, nothing committed. Scratch root `$S` =
`/tmp/claude-0/-home-user-the-workstation/ec6382e9-28d3-54c8-883c-b74c2a1383a3/scratchpad/scrut5/` (shots in `$S/shots/`).
Real SDK: `claude-haiku-5-5` (about 25 tiny turns, well under $0.15) plus one default-model "hello" (Sonnet, $0.025).
Fresh clone built in `$S/fresh` (`npm ci` 36 s, `npm run build` 14 s, `npm audit --omit=dev`: 0 vulnerabilities), servers on :7811-7814, all stopped by PID.
Layout lint (scrut4 script, mock, 16 combos): zero contrast / forbidden-hue / overflow / console errors; only the known hover-swap overlap on the sidebar row.

## Verdict: FIX-THEN-ALPHA, but close. The owner CAN start working with it today on a non-root machine.
All four pass-4 majors are verified fixed with the real SDK. The daily loop (feature across files, diff review, line comment sent back,
rewind, commit, two parallel worktree sessions, terminal, @file, slash commands, queue, stop, reload mid-turn, server restart + resume) works.
Fix the two MAJORs below (each small) before calling it stable; neither loses data.

## MAJOR
### M1. Running as root fails every real session with a cryptic error
- Repro: start the server as root without `IS_SANDBOX` (a normal devcontainer/Docker-as-root setup; here: `env -i ... node cli.js`), open a project, send "hello".
  Banner: "Claude Code did not initialize: Claude Code process exited with code 1. stderr: --dangerously-skip-permissions cannot be used with root/sudo
  privileges for security reasons" + "Retry" (Retry cannot help). Shot `$S/shots/n1-nocred.png` was the working run with `IS_SANDBOX=1`; failing run reproduced by text, same script.
- Cause: `packages/server/src/session-manager.ts:337` always passes `allowDangerouslySkipPermissions: true`. Not documented (README/DEVCONTAINER grep for root: nothing).
- Fix: only set it (and show "Bypass permissions" in the mode menu) when `process.getuid?.() !== 0 || IS_SANDBOX`; otherwise, map that stderr to an actionable notice and document it.
### M2. "Remove worktree" then Cancel at "Discard uncommitted changes?" kills the session and says it ended
- Repro (real SDK): worktree session with an uncommitted file, Overview > Remove worktree > confirm > second dialog "Discard uncommitted changes?" > Cancel.
  Conversation now shows "Session ended (worktree removed)" but the worktree and its changes still exist (`git worktree list`, `git status` in it). A running turn would be killed.
  Shot `$S/shots/g7-after-cancel.png`.
- Cause: `session-manager.ts removeSessionWorktree` calls `this.close(live, 'worktree removed')` before `removeWorktree` checks for uncommitted changes (`worktrees.ts:55-60`).
- Fix: check status first (or close only after `res.removed`).
### M3. After a worktree is removed and the page reloaded, its session is unreachable
- Repro: remove a worktree (forced), reload. Sidebar, Ctrl+K palette and home "Recent sessions" no longer list it, although `/api/sessions` returns it
  (`$S/shots/g9-home.png`, `g10-palette.png`). The removal dialog promises "Its history stays readable." True only until reload.
- Fix: group sessions whose cwd is under `<project>/.claude/worktrees/` by the project's recents (path-prefix match), not by exact cwd.
### M4. README installer line is dead
- `curl .../v0.1.0/scripts/install.sh` returns 404: the remote has no tag `v0.1.0` (no tags, no `main`; HEAD is the working branch). `scripts/install.sh` itself works
  (tested with `WORKSTATION_REF=<full sha>`, local repo: 24 s, `workstation --help` OK). Either push the tag or document the SHA form. The plain `git clone` + `npm ci && npm run build && npm start` path works literally.

## Pass-4 findings re-verified (user's seat, real SDK where it was found there)
- M1 untracked folder (real SDK, Write of `src/feature/a.ts`, `src/feature/b.ts`, `docs/notes/x.md`): Changes lists 3 file cards, each with a diff, no spinner, "3 files +3",
  Commit text "Stages and commits these 3 files"; deleting one card removed only that file ("2 files"), Commit committed exactly the 2 shown (`git show --stat` matched).
  Shots `a2-changes.png`, `a5-committed.png`. FIXED. (A 40+ file folder cap was not exercised.)
- M2 Settings overflow: 300-char Bash rule + long Read rule: `.dialog-body` scrollWidth == clientWidth at 1480/1100/800/560, 0 off-screen controls. `c1-settings-560.png`. FIXED.
- M3 bad key (real SDK, fake 401 base URL): exactly one banner "The API key was rejected (401). Check the key and base URL in Settings." + Open Settings (opens Settings);
  no retry card, no "external API key". `b1-401.png`. FIXED.
- Minor 1 long token in prose: conversation scrollWidth == clientWidth at all four widths; wraps. FIXED. Topbar at 560 shows title and cost, status dot. OK.
- Sidebar pinning: needs-input session older than 6 recents is still listed (7th row) with "Needs input" (`m1-sidebar.png`). OK.
- Toasts: approval toasts coalesce and disappear within ~2 s on the mock; real `Not connected` toast is stale after reconnect (see m5). Mostly OK.
- Diff comments persist across reload (localStorage, per browser; lost in a new profile). Sent review is plain text. Acceptable.
- Removed-worktree Changes poll: no 404/console errors in 16 s after removal. FIXED (but see M3).

## Daily-use trial: what worked (real SDK)
Feature across 3 files with @file mentions (menu, Tab completes); diff review; line comment -> Send to agent -> agent fixed exactly that line; Rewind > Restore code with honest dry-run
("1 file will be restored (+1 -6 lines)" + limits note) really reverted `lib/todo.js`; commit; two parallel worktree sessions with "Needs input" pins and toasts, both completed, main tree stayed clean;
terminal (pty, colours, exit message); queueing while working; Stop (idle in 8 ms, neutral "Stopped"); reload mid-stream (stream re-attached, "Working" restored);
server killed mid-turn: banner "Connection lost. Reconnecting...", typed message "Not sent / Retry", after restart it was sent and the session resumed (answered RESUMED);
slash commands /context (table), /model, /rename (sidebar updates); palette.

## MINOR
1. **History replay puts every turn footer after the last message.** After reload/reopen, "17s . 6 turns / 7.9s / 8.0s ..." stack together at the bottom and the final answer appears after them;
   live rendering is right. `e1-menu.png`, `i2-after-reload.png`, `j1-term-exit.png`. Fix in the history-to-rows mapper: emit the result row right after its turn.
2. **Focus lost after Stop** (`document.activeElement` is body, composer still drawn focused). Same after sending a diff review. Return focus to the textarea.
3. **Diff pane in the narrow inspector clips long lines and the comment text** ("removeTodo should throw if the id does not ex") and a card can stay horizontally scrolled
   with the gutter cut off after an update (`d3-after-reload.png`, `d4-done.png`). Wrap comments; reset scrollLeft on content change.
4. **Toast truncation prints "......"** ("exporting formatTo......", "findTodo...:...") in Approval toasts (`g2-sidebar.png`). Truncate once.
5. **Stale "Not connected - Could not start the session" toast** persists after the queued message was sent on reconnect (`k1-after-restart.png`). Clear on reconnect.
6. Interrupted-by-restart turn: the partial answer vanishes on reload and a literal "No response requested." appears; topbar says "Idle" while disconnected.
7. Slash menu: first Enter only completes ("/model " stays), second Enter runs; fine but non-obvious. Menu also lists dozens of unrelated skills first (environment-dependent) and internal `/__remote-workflow`.
8. Worktree sessions start by `cd`-ing into their own cwd, which the SDK flags ("changes directory before running a version-control command"): the permission card is accurate but alarming for the owner's own worktree.
9. Context card shows "4% used 44.7k" in a session that never got a response (bad-key case).
10. Carried: sidebar hover-swap overlaps the row "..." button (lint overlap), project picker footer path wraps mid-word.

## NIT
- Home shows "Open todo" twice (sidebar and main). Palette has no "Open terminal" / panel actions ("term" finds only a session).
- README says `npm start # opens http://localhost:7777/?token=...`; it prints `http://127.0.0.1:7777/?token=...`.
- First-run Settings is long for a welcome dialog (no scroll cue); revert/delete card icon is very faint until hover.

## Fresh install
README quickstart literal from a clean clone: works (see numbers above), first-run Settings appears, token printed, no console errors. Docs gaps: M1 (root), M4 (tag), no mention that sign-in
or an API key must already exist on the machine ("leave empty if signed in" is in the dialog only), and `npm install` prints "6 vulnerabilities" for dev deps (prod audit is clean).

## What I did not test
Windows/macOS/Firefox/Safari/Electron, a real Docker/devcontainer build, a machine with genuinely no credentials (the env here injects them), images, MCP failure states, a 40+ file new
folder (cap), 500-message conversations, screen readers, touch/IME, the full e2e suite (running elsewhere), compact vs comfortable beyond the lint matrix.
