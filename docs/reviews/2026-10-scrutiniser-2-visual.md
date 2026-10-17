# Scrutiniser pass 2: visual / UX / functional (2026-10-17)

Scope: `packages/web` as the owner sees it. I drove the mock server (`WORKSTATION_MOCK=1 WORKSTATION_MOCK_SPEED=0`, temp
`WORKSTATION_HOME`, a small git fixture project) and the in-browser `?demo=1` transport with Playwright on Chromium 1194
(`/opt/pw-browsers`). I read the screenshots against docs/UX.md, docs/BRAND.md, docs/PRODUCT.md and the owner's Claude Code
Desktop reference, and ran a programmatic layout lint on every state. I edited no source. Build: `npm run build` exit 0 at
HEAD `6461020`, with the other engineer's uncommitted server/devcontainer edits in the tree (no web files touched).

Scratch root: `/tmp/claude-0/-home-user-the-workstation/ec6382e9-28d3-54c8-883c-b74c2a1383a3/scratchpad/scrut2/` (`$S` below).
Screenshots are in `$S/shots/` and are named `<state>--<width>-<theme>-<brand>-<density>.png`.

Coverage: 213 screenshots and about 140 linted states. The states were home (empty and with recents), first-run settings,
settings, the project picker, a draft session, the `/` and `@` popups, the three composer chip menus, and every mock
scenario: plain, bash (pending, deny UI, queue, done, expanded), edit, write, todo, task, web, ask, plan (pending, edit,
reject, approved), slow, error, interrupt, and demo. Also every inspector tab (Overview, Plan, Changes, Files and file
preview, Tasks, Context, Terminal), overview collapse plus reload, the palette, shortcuts, the appearance popover, sidebar
hover, the context menu, rename, search (hit and miss), project collapse, sidebar hidden, inspector closed, the rewind
dialog, copy, toasts (sidebar shown and hidden), a wrong token, no token, reload, killing and restarting the server,
sending while offline, a 160-turn conversation (about 640 rows), and the `?demo=1` sessions, commit, discard, split,
fork, delete and MCP toggle. Matrix: 1480 light, dark, warm light, warm dark and comfortable; 1100 light compact and dark
comfortable; 800 light and dark; 560 light horizon and dark warm comfortable.

Tools I wrote (reusable):
- `$S/layout-lint.mjs` is the lint. Use it as `lintPage(page,{brand})` or as a CLI (`node layout-lint.mjs '<url>' --width 1480`,
  exit 1 on errors). Rules: overlap, touching (<1px gap between interactive elements), page-overflow, h-scroll, clipped,
  truncated-no-tip, **spill** (nowrap text painting over its neighbours), small-target (<24px), contrast (AA, computed and
  alpha-blended), forbidden-hue (horizon: hue 15–48°, s>0.5), no-name, img-alt, offscreen. It also has a `keyboardRun()`
  focus-ring walk. **Copy it to `packages/e2e/support/` and assert zero `error`-severity issues per state**; the scratchpad
  is not permanent.
- `$S/full.mjs` (full drive), `$S/matrix.mjs` (theme/brand/density/width), `$S/demo.mjs`, `$S/func.mjs` (functional
  pass/fail), `$S/resilience.mjs` (token, reload, reconnect), `$S/long.mjs` (long conversation). Results are in
  `$S/report-*.json`, `$S/func.txt` and `$S/resilience.txt`.

---

## BLOCKER

### B1. Every composer chip menu (mode, model, effort) and the Appearance popover opens at the far-left edge of the window, clipped
- **Repro:** open any session and click "Ask permissions", the model chip or "Medium" under the composer. The menu appears
  at x = −8 px over the sidebar, about 330 px from its chip, with its left padding cut off by the window edge. The sidebar's
  sliders button (Appearance) does the same. This happens at every width, theme, brand and density (lint `offscreen` in all
  14 matrix combos).
- **Expected:** the menu anchors to its trigger (above the chip, left-aligned). **Actual:** the menu is pinned to the left
  edge. Measured: `style="position: fixed; left: -8px; bottom: 36px"` with the chip at x = 326.
- **Cause:** `components/ui.tsx:116`. `Popover` measures `ref.current.offsetWidth` on the first layout while the portal div is
  still a static full-width block (1480 px), so `min(r.left, innerWidth - w - 8)` evaluates to −8.
- **Fix:** render the first frame with `position:fixed; left:0; top:0; width:max-content; visibility:hidden` (or measure in a
  second pass), then clamp `left` to `[8, innerWidth - w - 8]`. Regression: e2e asserting the popover's left edge is within
  16 px of its trigger.
- **Shots:** `$S/shots/menu-mode--1480-light-horizon-compact.png`, `menu-effort--…`, `appearance--…`,
  `m-menu-mode--1480-dark-horizon-compact.png`.

### B2. Toasts still cover the composer, and overhang the sidebar into the main pane (an owner complaint that is back)
- **Repro:** hide the sidebar (Ctrl+B), open Settings and click Save twice, or trigger any two toasts. The second toast sits
  over the composer's "+" and placeholder. With the sidebar visible, the toast is 272 px wide while the sidebar is 264 px,
  so it sticks 16 px into the conversation.
- **Cause:** `styles/app.css:227` sizes `.toasts` from `var(--sidebar-w, 288px)`. That variable is set inline on `.shell`
  (`App.tsx:75`), but `<Toasts/>` is rendered outside `.shell` (`App.tsx:103`), so the 288 px fallback always applies.
  With the sidebar hidden, nothing reserves space, and `bottom:44px` puts the stack on top of the composer.
- **Fix:** set the CSS variables on `.app` (or move `Toasts` into `.shell`). When the sidebar is hidden, anchor the toasts
  top-right under the topbar, or above the composer and outside its column. Regression: lint `overlap` of `.toast` against
  `.composer` with the sidebar hidden at 1480, 1100 and 800.
- **Shots:** `$S/shots/toast-sidebar-hidden--1480-light-horizon-compact.png`, `toast--1480-light-horizon-compact.png`,
  `m-toast--560-light-horizon-compact.png`.

### B3. Breaks at 800 px and is unusable at 560 px: no pane collapses, and text paints over text
- **Repro:** set the viewport to 800 with a session open. Sidebar (264) plus inspector (340) leave the conversation about
  197 px. The topbar crumbs clip to "(", the composer placeholder wraps over 5 lines, the chips stack vertically, and the
  one-line tool steps overlap ("Searched the web" is painted over "vitest…", "Fetched vitest.dev" over "Summ…"). At 560 the
  page scrolls horizontally (606 > 560), the composer textarea is **8 px wide** with its placeholder drawn one letter per
  line, the inspector runs off-screen, and Allow/Send are covered (Playwright clicks time out).
- **Expected (UX.md "responsive", REVIEW.md 800 px):** below about 1100 the inspector becomes an overlay or auto-hides;
  below about 800 the sidebar collapses to an overlay; the conversation keeps at least about 480 px.
- **Cause:** fixed pane widths with no breakpoints. The only media query is `app.css:129` (hide title and status pill).
  `.tool-title` (`content.css:57`) is `white-space:nowrap` with visible overflow, so it spills.
- **Fix:** add breakpoints that turn the inspector, then the sidebar, into overlays and give the conversation a
  `min-width`. Give `.tool-title` `overflow:hidden; text-overflow:ellipsis`. The lint's `spill` and `page-overflow` rules
  catch both.
- **Shots:** `$S/shots/m-demo-done--800-light-horizon-compact.png`, `zoom-800-tools.png`,
  `m-draft--560-light-horizon-compact.png`.

## MAJOR

### M1. "Edit" on a plan opens an EMPTY editor; "Approve edited plan" would send an empty plan
- **Repro:** start a new session, send "make a plan", wait for the Plan card and click **Edit**. The textarea is empty
  (`$S/shots/sc-plan-editing--1480-light-horizon-compact.png`).
- **Cause:** `components/PermissionCards.tsx:149` calls `useState(plan)` when the card mounts during streaming, while
  `block.input.plan` is still empty, and never re-syncs. `approve()` then sends `updatedInput: {plan: draft}` (`:153`)
  with `draft === ''`. The last step is inferred from the code; I did not submit an empty plan end-to-end.
- **Fix:** seed the draft when entering edit mode (`setDraft(plan)` in the Edit handler), and disable approve when the
  draft is empty.

### M2. A wrong or missing token shows "Connecting to the server…" forever, with nothing actionable
- **Repro:** open `/?token=wrong-token` or `/`. The banner reads "Connecting to the server… Retry now" indefinitely and Home
  says "Connecting…". The only signal is a console error (`WebSocket … failed: HTTP Authentication failed`).
- **Expected (UX.md error states, PRODUCT.md item 6):** "This link's access token is missing or wrong. Open the URL printed
  by `workstation` (it contains `?token=`)." Do not keep retrying on a 401.
- **Where:** `components/Overlays.tsx:72`. **Shot:** `$S/shots/res-wrong-token.png`, `res-no-token.png`.

### M3. The rewind dialog does not say that Bash or shell changes are not restored (Honest UI, PRODUCT.md principle 5)
- **Repro:** hover a user message, click "Rewind files to here" (↶). The dialog says "Files Claude changed after this message
  will be restored to how they were. Your conversation stays as is." It says nothing about edits made through Bash (`sed`,
  `npm install`, generators, deleted files), which SDK checkpoints do not track.
- **Fix (`components/RowList.tsx:42`):** add "Only edits made with Claude's file tools are restored. Changes made by shell
  commands (Bash) are not." Also render the `+3 −1 lines` summary as a summary line, not as a bullet in the monospace file
  list. **Shot:** `$S/shots/rewind-dialog--1480-light-horizon-compact.png`.

### M4. Every TodoWrite renders a full Plan card; old snapshots keep an "in progress" spinner forever
- **Repro:** send "todo list please". Three Plan cards stack up (0/3 with a spinner, 1/3 with a spinner, 3/3 done), and the
  stale cards keep animating after the turn ends. The demo run has the same problem (a "Plan 0/3" card with "Reading the
  codebase" spinning at the top of a finished session).
- **Expected (reference):** one live checklist. Earlier snapshots collapse to a muted one-line "Updated plan" step, and
  nothing animates once the turn is done.
- **Shots:** `$S/shots/sc-todo--1480-light-horizon-compact.png`, `sc-demo-top--1480-light-horizon-compact.png`.

### M5. Sidebar: a "needs input" row looks more selected than the open row
- **Repro (`?demo=1`):** open "Add dark mode to settings page" while "Migrate build to Vite 6" waits for approval. The
  waiting row has a stronger blue fill and a 3 px left bar, while the open row has a paler fill. Two rows look selected,
  and the wrong one looks primary. The mock shows the same thing with two waiting sessions.
- **Fix:** keep the selected style unique (fill plus bar), and show attention only with the dot, or a dot plus bold title,
  never a fill. **Shots:** `$S/shots/func-commit.png`, `$S/shots/probe-make_a_plan.png`.

### M6. The topbar branch disagrees with the Environment card and the Changes header
- **Repro (`?demo=1`, first screen):** the topbar shows `chore/vite-6`, while Environment and Changes show `feat/dark-mode`.
  In the mock after a reload, the topbar shows `main` while git (and Environment) show `master`. The topbar reads
  `session.branch` (SDK or summary metadata), and the overview reads live `git status`.
- **Fix:** use one source of truth: the live git branch of the session's checkout, with the session's worktree branch when
  there is one. **Shots:** `$S/shots/demo-session1--light.png`, `long-mid.png`.

### M7. Split diff cannot be used in the inspector
- **Repro (`?demo=1`):** go to Changes and select **Split**. At the default 340 px width only the old column is visible. The
  new column is cut off, so a new file (`useTheme.ts`) shows an empty grey box and modified files show only the removed or
  context side.
- **Fix:** hide Split below about 640 px pane width, or widen the inspector (or open a full-width review) when Split is
  chosen. **Shot:** `$S/shots/func-split.png`.

### M8. A message sent while disconnected gets stuck as "queued" forever
- **Repro:** kill the server with a session open, type a message and press Enter. A toast says "Not connected · Could not
  start the session" and the text moves to the queue (it is not lost). Restart the server: the banner clears and the
  conversation shows an amber "Session ended (server shutdown)", but the queued item stays "queued" and is never sent.
  There is no "send now" or retry.
- **Fix:** flush or resubmit the queue once the session re-attaches, or show "Not sent · Retry" on the item.
  **Shots:** `$S/shots/res-send-while-down.png`, `res-server-back.png`.

## MINOR

1. **The pending WebFetch card says "Fetched vitest.dev"** while it is still waiting for permission (`components/ToolCards.tsx:180`).
   Edit and Bash switch tense correctly; WebFetch and WebSearch do not. Shot: `sc-web-perm--1480-light-horizon-compact.png`.
2. **Reload drops you on Home**: the active session is not restored (checked after 2.5 s). Desktop apps reopen where you
   were. Fix: persist `activeId` and re-open it once summaries load.
3. **Wrong context numbers after a resume**: after reconnecting, the same session that showed 13% (25.7k) shows "<1% used ·
   920 / 200k" (last turn only). `?demo=1` sessions with history say "Usage appears after the first response". Shots:
   `res-server-back.png`, `demo-session2--light.png`.
4. **Git status is not refetched after a reconnect** (`/api/git/status` failed during the outage). Changes then shows
   transcript-derived "2 files +5 −1" while the tree is clean, and the branch shows the stale `main`.
5. **The error banner has no action**: "Something went wrong · …" has no Retry and no link to Settings (PRODUCT.md roadmap
   item 6). Shot: `sc-error--…`.
6. **A user-initiated stop is rendered as an error**: after Stop, the Bash step turns red with a ⚠ icon. It should be
   neutral and read "Stopped". Shot: `sc-interrupted--…`.
7. **Keyboard and screen reader:** session actions (…) are a `span role=button tabIndex=-1` nested inside a `<button>`
   (`Sidebar.tsx:173`), so rename, fork and delete cannot be reached by keyboard. Settings has no focus trap (Tab leaves the
   modal). The command palette dialog has no accessible name. The inspector tabs are 7 separate Tab stops (no roving
   tabindex or arrow keys). Every `Spinner` is a `role=status` live region. Passing checks: every focus stop shows a ring,
   Esc closes the palette, Settings and Shortcuts, and focus returns to the opener.
8. **Expand state is not kept**: thinking and tool cards collapse again when you switch sessions and come back
   (`func.txt`). Overview card collapse does persist across reload.
9. **Contrast (computed, AA):** thinking preview 3.42:1 (`--muted` at 0.8 opacity); separator dot 2.03:1; red syntax
   keywords on green "+" diff rows 3.9:1 (they also read as deletions); error-banner subtext 4.32:1; dark-mode needs-input
   dot on the selected row about 3:1. Warm brand (alternate): muted text 3.96–4.25:1, and white on terracotta primary
   buttons 4.23:1 (light) and **3.12:1 (dark)**.
10. **Hit targets under 24 px:** MCP switches 26×15 (Overview) and 32×18 (Context); the picker crumb "/" 11×20; terminal
    tab close 21×19; the edit card's "Review" 46×18; the sidebar search input and project header 22 px high.
11. **Interactive controls with 0 px gaps** (the same class of problem as the old touching rows): the three composer chips
    (their hover fills abut), the sidebar footer icons, picker breadcrumbs, and file-tree rows. Sidebar session rows now
    have a 4 px gap, so that complaint is fixed.
12. **Sidebar hover clips the title mid-glyph with no ellipsis** when the time and "…" appear ("…settings pag| 12m", "tell
    me so| 1m."). Shots: `demo-session2--light.png`, `long-mid.png`.
13. **Ctrl+N is reserved by Chrome** and cannot be intercepted, yet the palette and the Shortcuts list advertise it. Use
    Ctrl+Shift+O, Alt+N or similar in the browser and keep ⌘N for Electron. This is inferred from Chromium's
    reserved-shortcut behaviour; headless Playwright cannot show it.
14. **The Settings title is "Welcome. Set up your connection" every time** no key is stored, which includes everyone who
    relies on a Claude Code login (`SettingsDialog.tsx:65`).
15. **Appearance labels differ between surfaces:** the popover says Auto/Light/Dark and Compact/**Roomy**, while Settings
    says System/Light/Dark and Compact/**Comfortable**. The Settings theme row has no label while Brand and Density do, and
    it sits on the opposite side. The "Warm" brand icon is the same sun as the "Light" theme.
16. **Copy presents the product as "Claude Code"**: Home says "Run Claude Code agents side by side" (`Conversation.tsx:133`)
    and Settings says "used as environment for Claude Code". PRODUCT.md non-goals say: "Our name is The Workstation; copy
    says 'built on the Claude Agent SDK'."
17. **Amber is the only orange-family colour left in Horizon**: `--warn` `#8a5700` (h≈38°) for the "Session ended" notice
    (lint `forbidden-hue`), and a beige `--warn-soft` (h≈42°) for the reconnect banner. The owner needs to decide; my
    recommendation is a neutral or info treatment for the reconnect banner and a yellow at hue ≥ 48° for warnings.
18. **The Bash card is verbose:** the command appears 3 times (head, the `$` box, and the permission title "Claude wants to
    run: npm test …") and the description twice. The output starts with a blank line and sits box-in-box. The pending card
    has a halo, a blue border and a 3 px left bar: three blue edges. Shots: `sc-bash-deny-ui--…`, `zoom-perm.png`.
19. **Permission titles show absolute paths** that wrap to 2 lines ("Claude wants to edit /tmp/…/project/src/example.ts").
    Show the project-relative path and put the absolute one in the tooltip.
20. **New files show a red `−0`** ("Created NOTES.md +3 −0"). Omit zero counts.
21. **Duplicate information:** Background tasks shows "1 finished" in the header and "› 1 finished" in the body; the Tasks
    tab repeats "Explore the repo" twice; the Context tab duplicates the Overview Context and Connectors cards; the Changes
    card has both "Review changes ›" and a "Review" link.
22. **Project picker:** the path appears three times (field, breadcrumbs, footer). The footer truncates the *end* in
    monospace. The breadcrumbs start "/ / tmp". The project card on Home also end-truncates the path.
23. **The Changes tab with 0 files** still shows Unified/Split, collapse-all and refresh.
24. **A stale attention toast** ("Approval needed · Migrate build…  Open") stays for 10 s after you open that session.
25. **First run:** the server was started with `--cwd <project>`, yet Home and the sidebar say "No projects yet" and the
    only path is the folder picker. Offer the server cwd as a one-click "Open <name>".
26. **The project header is uppercase** (`PROJECT`, `ACME-WEB`), which loses the folder's real case. The reference uses
    muted normal case.

## NIT
- "Claude has a question" next to the count "2 questions" (singular and plural mismatch). The question card uses the
  shield (permission) icon.
- While a permission is pending, the composer placeholder says "Claude is working. Type to queue a follow-up…" when
  Claude is actually waiting for you.
- The effort chip keeps a hover fill after its menu is closed with Esc.
- Files preview header shows the directory as "." for root files ("README.md · . · 10 B").
- "Jump to latest" floats over message text (acceptable, but it covers a line).
- Context Mode shows the raw id "default" while the chip says "Ask permissions". Under Warm, Messages and System tools
  share nearly the same terracotta in the context bar.
- Mock fidelity: mock Edit and Write do not touch disk, so the mock shows "Outputs 2" next to "Changes: Working tree is
  clean". The owner evaluates with the mock, so it contradicts itself.

---

## What already works (verified, for scoping the fixes)
- **No orange in Horizon:** zero `forbidden-hue` hits in about 120 Horizon light and dark states. The only exception is the
  amber warn notice (MINOR 17).
- **Functional checks that pass (`$S/func.txt`):** image attach and preview, Unified/Split toggle, collapse/expand all,
  discard confirm (clear wording: "This file is new. It will be permanently deleted from disk."), commit with a toast,
  Files→Mention inserting `@package.json`, MCP switch, Outputs/Review/Details/context-ring navigation, fork, delete with
  confirm, rename, search, palette Enter, Esc on every dialog, copy to clipboard, queue and remove, interrupt.
- **No "Create PR", Push or other unbuilt actions are shown.** No console errors or failed requests in normal flows; the
  only ones were on a wrong token and while the server was down.
- **Long conversation:** 160 turns (about 640 rows, 7.9k DOM nodes) open in 0.7 s. Scroll frames p50 18 ms and p95 24 ms;
  a keystroke takes 33 ms to paint (two-frame floor). This is fine on this machine, though there is still no
  virtualization.

## Top 10 things the owner would notice first
1. The mode, model and effort menus pop up at the far-left edge of the window, away from the chip (B1).
2. Toasts cover the composer again, or stick out of the sidebar (B2).
3. Shrinking the window (half-screen, about 800 px) crushes the conversation into a strip with overlapping text (B3).
4. The topbar branch differs from the branch in Environment and Changes on the first demo screen (M6).
5. Finished sessions show stacks of stale Plan cards that are still spinning (M4).
6. Two sidebar rows look selected, and the waiting one looks more selected than the open one (M5).
7. Plan → Edit opens an empty box (M1).
8. A wrong or expired token link spins on "Connecting…" forever with no explanation (M2).
9. Split diff shows blank or one-sided panes (M7).
10. The Bash permission card repeats the command three times inside three blue edges (MINOR 18).

## Verdict
**FIX-THEN-SHIP.** Each blocker has a small, local fix: popover measurement, where the toast CSS variable is set,
breakpoints plus ellipsis, and plan draft seeding. Until B1–B3 and M1–M8 are fixed and re-checked with
`layout-lint.mjs` wired into e2e, this should not be shown to the owner as done. B2 repeats an owner complaint, and B1
is the first thing anyone clicking a composer chip will see.

## What I did not test
- The real SDK path (mock and demo transport only), Electron or a packaged build, and Firefox or Safari (Chromium 1194
  only).
- Real OS notifications, drag-and-drop images, a 20 MB paste, IME composition, RTL or long unicode titles, touch input,
  and `prefers-reduced-motion`.
- A real screen reader. Accessible names and roles were checked only programmatically.
- Dragging the pane resizers, terminal behaviour beyond opening one, the worktree flows, very large tool output, and
  actually running a rewind (I only opened the dialog).
- Submitting an edited (empty) plan end-to-end (M1's last step is from the code). Ctrl+N in a headed Chrome (MINOR 13 is
  inferred).
- The full matrix for every state: comfortable density and the warm brand were checked on the key-state subset only, and
  1100/800/560 on the subset in `$S/matrix.mjs`.
- I did not re-run the repo's e2e or unit suites. This pass was visual and functional only.
