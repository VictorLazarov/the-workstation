# UX principles (binding for all web work)
We are building a **desktop-app-style agent workspace** (reference: Claude Code Desktop, Cursor's Agents tab,
GitHub Copilot app). NOT a terminal emulator and NOT a CLI transcript in a browser.

- **Layout**: left sidebar = projects → sessions (grouped, status dots: running / needs-input / done / error,
  relative time, branch). Center = conversation. Right = collapsible, tabbed inspector (Changes/diff review,
  Files, Plan/Todos, Tasks/subagents, Context, Terminal, Preview). Top bar = project, branch, model, mode.
- **Parallel agents are first-class**: many sessions run at once; sidebar shows live status; notifications
  when one needs permission or finishes. Each can use its own git worktree.
- **Rich tool rendering**: no raw JSON/ANSI. Edit/Write → inline diff cards with +/- counts, click to open in
  Changes pane; Bash → command card with collapsible output and exit status; Read/Grep/Glob → compact
  chips ("Read 3 files"); Task/subagent → nested collapsible group with progress; TodoWrite → live checklist;
  WebSearch/Fetch → source cards; images render inline.
- **Review workflow**: per-session aggregated "Changes" view (file list, side-by-side/unified diff, per-file
  stats), checkpoint restore ("rewind to here") on each user message, commit action.
- **Composer**: multiline rich input, @file mentions, /commands + skills palette, image paste/drag, model/effort/
  permission-mode chips inside the composer, queued messages while running, stop button.
- **Permission UX**: inline approval cards with the actual diff/command, Allow once / Always allow / Deny
  with feedback; plan mode shows a plan review card (Approve / Edit / Reject).
- **Polish**: Claude-like warm neutral palette, serif-accented headings, light/dark, command palette (⌘K),
  keyboard shortcuts, smooth streaming, resizable panes, responsive, accessible (focus rings, aria).
- Empty states, loading skeletons, error toasts, reconnect banner. No dead buttons: if a feature isn't built, hide it.

## Responsive layout (binding)
- **> 1100px**: sidebar and inspector are docked panes (resizable). **<= 1100px**: the inspector is an overlay drawer on the
  right (scrim, Esc or scrim click closes it; it starts closed). **<= 800px**: the sidebar is a drawer on the left, opened by
  the hamburger in the topbar, and closes when you pick a session. The conversation never drops below ~480px while docked,
  there is never a horizontal page scroll, and the composer and permission buttons stay usable down to 360px.
- Drawer open/closed state is transient; the saved docked layout comes back on a wider window.
- One-line tool steps ellipsize (`min-width: 0` + `text-overflow`), they never paint over their neighbours.
- Popovers and menus are placed after measuring (anchored to the trigger, flipped to the side with room, clamped to the
  viewport). Toasts: bottom-left inside the sidebar column while it is docked, otherwise top-right under the topbar; they
  never cover the composer, the inspector tabs or the commit box.
- Split diff needs a wide inspector (>= 620px); below that it falls back to unified.

## Keyboard shortcuts
- `Ctrl/Cmd+K` palette, `Ctrl/Cmd+B` sidebar, `Ctrl/Cmd+Alt+B` inspector, `Ctrl/Cmd+,` settings, `Ctrl/Cmd+O` open project,
  `Ctrl/Cmd+1..9` jump to session, `Ctrl/Cmd+Enter` allow the pending request, `Ctrl/Cmd+/` the list.
- **New session: `Alt+N` in the browser, `Cmd+N` on macOS and in the desktop app.** `Ctrl+N` is reserved by Chrome (it opens a
  new window and a page cannot intercept it), so the browser build does not advertise it.
- Session actions (rename, fork, delete) are a real button next to each row, and the context-menu key / `Shift+F10` opens the same menu.

## Visual quality gate
- `packages/e2e/support/layout-lint.ts` (run by `tests/app/layout.spec.ts`) fails on overlap, touching controls, horizontal
  overflow, clipped or spilling text, hit targets under 24px, contrast under AA, orange hues in the Horizon brand, controls
  without an accessible name and console errors, over every mock scenario, each inspector tab, dialogs and menus, at 1480 /
  1100 / 800 / 560px in light and dark. Warning colour is a gold-yellow (hue ~50°), never orange.
