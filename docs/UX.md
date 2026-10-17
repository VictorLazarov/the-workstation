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
