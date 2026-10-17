# Research: Claude Code Desktop, Cursor Agents Window, GitHub Copilot app

Compiled 2026-10-17 for The Workstation. Method and limits matter for how far to trust this file:

- **Fully read (primary source):** code.claude.com desktop docs (first ~100k of 153k chars; the rest was SSH/remote admin detail), the checkpointing doc and the Agent SDK overview.
- **Search-snippet only:** everything on Cursor and GitHub. The research sandbox's egress proxy blocks cursor.com, github.blog, docs.github.com, code.visualstudio.com and every third-party blog (WebFetch failed with DNS or 403). I could read those sources only as WebSearch summaries. Each such claim is tagged **[snippet]**. Cursor and GitHub facts are therefore thinner and less verified than the Claude facts.
- **Not found:** Cursor's own "why we built it" write-up, and the full text of Anthropic's redesign blog. Where a "rationale" appears, I say who stated it. Do not treat third-party framing as the vendor's words.
- Dates: Cursor 3 released 2026-04-02 [snippet]; Claude Code desktop redesign 2026-04-14 [snippet]; GitHub Copilot app technical preview 2026-05-14 (announced at Build 2026) [snippet].

---

## 1. Claude Code Desktop (the "Code" tab of the Claude desktop app)

Sources: https://code.claude.com/docs/en/desktop (read); https://code.claude.com/docs/en/checkpointing (read); redesign announcement https://claude.com/blog/claude-code-desktop-redesign (not fetchable; summarized via search results only).

### Layout and information architecture
- The app has three tabs: Chat, Cowork, Code. Each Code conversation is a **session** with its own history and project folder.
- Redesign (Apr 2026) is a pane system: chat, diff, browser, terminal, file editor, plan, tasks, subagent (and iOS Simulator on macOS). Panes are dragged by header to reposition and by edge to resize. Title-bar buttons: Terminal, Changes, Browser; a overflow menu adds Files.
- Diff or terminal can be **popped out** into its own window and docked back. Cmd/Ctrl-click a sidebar session opens **split view** of two sessions.
- Sidebar: active and recent sessions together; filter by status/project/environment; group by project; rename by clicking the toolbar title; archive icon. Cycle sessions with Ctrl+Tab.
- Three **view modes** (Ctrl+O): Normal (tool calls collapsed), Thinking, Verbose (every step).
- A **usage ring** beside the model picker shows per-session context usage and shared plan usage.

### Session / agent model
- Before the first message you pick four things: **environment** (Local, Cloud, SSH, WSL), **project folder**, **model**, **permission mode**. The permission mode is remembered per folder.
- Parallel sessions are the headline. The **worktree** toggle beside the branch name isolates a session in a git worktree at `<repo>/.claude/worktrees/` (configurable). Settings: branch-name prefix; `.worktreeinclude` copies gitignored files (e.g. `.env`) into new worktrees. Archiving a session deletes its worktree; local sessions auto-archive after their PR merges or closes.
- **Cross-session work:** Claude can list, read, message, rename and archive other desktop sessions. Messages are attributed and quoted, held while the receiver is busy, and gated by the receiver's `crossSessionInbound` setting. Archiving needs an approval card except in Auto/Bypass.
- **Task chips:** Claude offers out-of-scope findings as a chip that spawns a new session with its own worktree.
- **Side chat** (Cmd/Ctrl+; or `/btw`): a question that reads the main thread but writes nothing back; not persisted to disk.
- **Continue elsewhere:** "Open in" moves a session to cloud or an editor. Cloud sessions keep running after the app closes. Dispatch (phone-driven persistent chat) can spawn Code sessions, shown with a Dispatch badge.
- Auto compaction when context fills; `/compact` manual.
- Checkpoints (checkpointing doc): every prompt that starts a turn creates a checkpoint (last 100 retained, ~30 day retention sweep). `/rewind` / double-Esc offers: Restore code and conversation, Restore conversation, Restore code, Summarize from here, Summarize up to here. The rewound prompt returns to the input box for edit. **Limits stated:** Bash-made file changes, subagent edits (mostly) and external edits are not tracked; symlinks/hardlinks skipped; "not a replacement for version control". Messages typed mid-turn get no checkpoint of their own.

### Review / diff workflow
- A **diff stats indicator** (`+12 -1`) opens a viewer: file list left, changes right. **Click any line to comment**, submit all comments at once with Cmd/Ctrl+Enter; Claude applies them as a new diff.
- `/code-review` produces a **Code review card** grouped by file with actions **Walk through in diff**, **Fix this one**, **Apply fixes**.
- **CI status bar** after a PR is opened (polls via `gh`). **Auto-fix CI & address comments** (reads failures, iterates, also addresses new review comments from owners/members/collaborators/apps) and **Auto-merge when ready** (squash once checks pass; needs auto-merge enabled on the repo).
- **Preview:** Claude starts a dev server (configured in `.claude/launch.json`: name, runtimeExecutable, args, port, cwd, env, autoPort, url) and shows it in the Browser pane. `autoVerify` (default on) makes it screenshot, check errors and confirm after each edit. HTML/PDF/image/video paths in chat open in the Browser pane. External pages use a clean browser profile; every new site needs approval (Allow once / Always / Deny) and write actions go through safety classifiers.
- Files in chat or diff open an in-app file editor (Save / Discard, warns on external change). Right-click a path: Attach as context, Open in VS Code/Cursor/Zed, Show in Finder, Copy path.

### Permission and plan UX
- Five modes: Manual (`default`), Accept edits, Plan, Auto (background classifier, needs supported models), Bypass (sandbox only). Cloud supports only Accept edits/Plan/Auto. Enterprises can disable Auto/Bypass.
- Manual mode offers per-change accept/reject. Stated best practice: **start complex work in Plan, review the approach, then switch to Accept edits or Manual.**
- Computer use has fixed tiers by app category (view only for browsers, click only for terminals/IDEs, full otherwise) and a denied-apps list.

### Composer
- Enter sends; Stop interrupts. **A correction typed mid-action is read after the current action finishes** (queue-style). `+` button: attachments, skills, connectors, plugins, slash commands. `@file` mentions (local/SSH only). Images and PDFs by button or drag-drop. `/` palette lists built-ins, personal/project/plugin skills. **Suggested next prompts** appear as grey text, Tab or Right-arrow to accept; they cost a small background request and can be disabled.
- Model picker, permission mode and environment are selected pre-session; the usage ring lives next to the model picker.

### Notable details
- OS notification when a session finishes and is not in view. Customize panel in the sidebar unifies connectors, skills, plugins.
- Integrated terminal shares Claude's environment (same files/env).
- Aakash Gupta (X, third-party) observes there is no code editor in the main interface and the sidebar is a task list ("Fix race condition in upload queue") [snippet, opinion].

### Stated rationale
- Docs state: worktrees so each session "tracks its own context and changes independently"; side chat so questions don't "steer the session off course"; browser so Claude verifies its own UI/API changes; Dispatch/cloud so work continues away from the terminal; classifiers/tiers for safety; Code tab gives a GUI for people who prefer visual interface over CLI.
- Anthropic redesign post (via search summaries, wording not verified): developers now run several agentic tasks at once (refactor in one repo, bug fix in another, tests in a third) instead of one prompt and wait; the app is built around the user as **orchestrator** [snippet].

---

## 2. Cursor (Cursor 3 "Agents Window", codename Glass)

Sources, all via search results only [snippet]: https://cursor.com/changelog/3-0 ; https://cursor.com/docs/agent/agents-window ; https://cursor.com/docs/configuration/worktrees ; https://cursor.com/blog/plan-mode ; https://cursor.com/docs/agent/plan-mode ; https://cursor.com/docs/agent/overview ; forum threads https://forum.cursor.com/t/cursor-3-agents-window/156509 and https://forum.cursor.com/t/availability-of-worktree-and-best-of-n-in-agents-window/156675 ; reviews https://dev.to/gabrielanhaia/cursor-3-glass-replaced-composer-with-an-agents-window-1pcg and https://www.digitalapplied.com/blog/cursor-3-agents-window-design-mode-complete-guide .

### Layout and IA
- Agents Window is a **new primary interface**, built from scratch rather than derived from VS Code (internal codename Glass). Open via command palette ("Agents Window"); switch back to the IDE any time, or run both.
- A **sidebar lists all agents** regardless of origin: local, worktree, cloud, remote SSH, and agents kicked off from web (cursor.com/agents), mobile, Slack, GitHub, Linear.
- **Each agent gets its own tab**; tabs can be viewed side by side or in a grid. **Multi-workspace by default**: one agent session may target several repos.
- Files can be opened without leaving: Cmd+P file search, Cmd+Shift+F search-all (docs, per search summary).

### Session / agent model
- Agent session is the unit of work (reviewers: unit shifted "from file to agent session") [snippet, opinion].
- **Worktrees:** docs say Agents Window can start or move an agent into a worktree. `/worktree` creates an isolated checkout for the rest of the chat; `/apply-worktree` brings results back to the main checkout; `/best-of-n` runs the same task on several models, each in its own worktree, and you pick the winner. **Uncertain:** forum reports say these slash commands initially worked only in the classic editor layout, with a later fix pending; docs may lag. Verify before copying the exact UX.
- **Cloud <-> local handoff**: pull a cloud agent local to iterate, push back to keep it running.
- Agent overview: Enter queues a message; Cmd+Enter sends immediately (per search summary of docs). Checkpoints with "Restore Checkpoint" on earlier requests (secondary guide, unverified).

### Review / diff workflow
- "Simpler diffs view for faster review", plus **stage, commit and manage PRs without leaving the window** [snippet of changelog].
- Design Mode (Cmd+Shift+D): integrated browser; Shift+drag selects a UI region; Cmd+L sends the element to the agent chat. The agent can open local sites, screenshot, read DOM, read console.

### Permission and plan UX
- **Plan Mode** (Shift+Tab; Cursor also auto-suggests it for complex tasks): the agent researches the codebase, asks clarifying questions, then writes a **Markdown plan with file paths and code references** that you edit inline (add/remove to-dos), and waits for approval; then Build. Plans live in the home dir by default; "save to workspace" puts them in `.cursor/plans/`.
- Forum-reported rough edges (unofficial): Build can drop out of Plan mode; manual plan edits sometimes not picked up (staff called it a known issue); "build in new agent" exists in IDE but not Agents Window.
- I did not find Cursor's permission-prompt UI details (allowlist, sandbox) in these results. **Unverified.**

### Stated rationale
- Cursor blog (via summary): "most new features at Cursor now begin with Agent writing a plan"; plan mode suits complex/cross-cutting work, simple changes go straight to Agent.
- For Agents Window, **no first-party rationale found**. Third parties frame it as a bet that you will manage agents rather than write code. Treat as commentary.

---

## 3. GitHub Copilot app, Copilot coding agent, VS Code agent sessions

Sources [snippet unless noted]: https://github.blog/changelog/2026-05-14-github-copilot-app-is-now-available-in-technical-preview/ ; https://github.blog/news-insights/product-news/github-copilot-app-the-agent-native-desktop-experience/ ; https://github.com/github/app ; https://docs.github.com/en/copilot/concepts/copilot-surfaces/github-copilot-app ; https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions ; https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests ; coding agent: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilot-sessions and https://github.blog/changelog/2026-03-19-more-visibility-into-copilot-coding-agent-sessions/ ; VS Code: https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development and https://code.visualstudio.com/learn/foundations/agent-sessions-and-where-agents-run .

### Copilot app: layout and IA
- Standalone desktop app (Win/macOS/Linux), technical preview, described as built on GitHub Copilot CLI. Tagline from the repo: "agent-native desktop experience for **finding, running, steering, and landing** software work across your GitHub repositories".
- **My Work** view: sessions + issues + PRs + repo context in one place. Sidebar sections default to All, Active, Review requests, Done, with user-defined filters.
- **Canvases:** open, agent-driven artifacts/interfaces where people and agents collaborate (docs mention briefly). Community guides describe plans, PR diffs, terminal output, live browser as canvases; that detail is third-party, unverified.

### Session model
- Each local session = its own **git worktree**, managed automatically (no manual setup/cleanup). Cloud sessions run in GitHub-hosted environments and can be picked up anywhere.
- Start a session **from an issue** ("New session" loads the issue context) or from a PR (with review comments on the diff).
- **Session modes** under the prompt: Interactive, Plan, Autopilot. Docs advice: Plan to validate scope/approach, Interactive for tight steering, Autopilot once well-defined. (JetBrains docs for the CLI note Autopilot governs pausing for input, not approval for permissioned actions; may not match the desktop app.)
- **Agent Merge:** toggled from top of the app; prompts the workspace's session to read the PR, fix blockers (CI, review feedback), and merge when GitHub allows; runs in background and survives restarts.

### Review / diff
- PR "Files changed" tab inside the app; leave review comments or ask the agent to change things. Microsoft course advice: verify diff, test/build output, running app, PR checks before calling done.

### Coding agent (cloud, github.com) and VS Code
- Coding agent: **session logs** show reasoning and tools used; each commit links to its session log (traceability for review/audit). **Steering:** you type in the prompt box under the log; the agent applies it after its current tool call. On finish: Overview tab (summary) and Files changed tab, then normal PR review. A firewall page governs allowed domains (details not retrieved).
- VS Code Agent Sessions: one list of local, background, cloud sessions; move among them; "Continue In" hands a session to another agent type with full context; sessions can be promoted into an editor tab or separate window. Placement shifted across releases (1.107 integrated it into the Chat view) so details are version-dependent.

### Stated rationale
- GitHub frames the loop as find / run / steer / land, and Agent Merge as letting you "stay focused on judgment, quality, and delivery" [snippet of official text]. Worktree-per-session is stated as preventing parallel agents from interfering [snippet]. VS Code blog: one place to see all sessions and move between them as you work [snippet].

---

## 4. Cross-product comparison

| Dimension | Claude Code Desktop | Cursor Agents Window | Copilot app |
|---|---|---|---|
| Primary unit | Session (folder/branch) | Agent tab | Session tied to issue/PR |
| Home view | Sidebar sessions, filter/group by status/project/env | Sidebar of all agents, any origin | "My Work" (sessions + issues + PRs) |
| Multi-pane | Drag-drop panes, pop-out windows, split sessions | Tabs, side by side/grid | Canvases (details unverified) |
| Isolation | Worktree toggle, auto-clean on archive | /worktree, /best-of-n (UI availability uncertain) | Worktree per local session, automatic |
| Cloud/remote | Cloud, SSH, WSL, Dispatch | Cloud, SSH, Slack/Linear/GitHub origin, handoff | Cloud sessions |
| Review | Click-line comments batched; code-review card; file editor | Simpler diffs, stage/commit/PR in-window | Files-changed tab, comment or ask agent |
| Landing PR | CI bar, auto-fix, auto-merge | Manage PRs in window | Agent Merge |
| Modes | Manual / Accept edits / Plan / Auto / Bypass | Agent / Plan / Ask (Ask unverified here) | Interactive / Plan / Autopilot |
| Plan UX | Plan pane; then switch mode | Editable Markdown plan file, Build | Approve plan before execution |
| Rewind | Checkpoints: code and/or conversation, summarize | Restore Checkpoint (unverified) | Not found |
| Browser | Pane with launch.json, autoVerify | Built-in browser, Design Mode | Canvas browser (unverified) |
| Side question | Side chat (/btw), non-polluting | Not found | Not found |
| Queue mid-run | Typed corrections read after current action | Enter queues, Cmd+Enter immediate | Steer after current tool call |
| Provenance | Task chips, attributed cross-session msgs | Origin-agnostic sidebar | Commit -> session log link |

---

## 5. Top 15 ideas to adopt (prioritized)

SDK mapping notes: SDK capabilities confirmed from https://code.claude.com/docs/en/agent-sdk/overview: tools, hooks, subagents, MCP, permissions, sessions (resume/fork), skills/commands/memory, plugins. Items marked (verify) rely on SDK features I know of but did not re-read in this research (partial streaming, `canUseTool`, file checkpointing/`rewindFiles`, `permissionMode` values, `getSupportedCommands`).

1. **Sidebar of sessions with live status, filters (status/project/env) and grouping, auto-archive.** Why: the orchestrator model is the core of all three products. SDK: sessions + message stream drive status (running / waiting on permission / done). Effort M.
2. **Worktree toggle per session, default location in repo, `.worktreeinclude`-style copy of gitignored files, cleanup on archive.** Why: parallel isolation is stated by Claude and Copilot as the reason it works at all; automatic management (Copilot) is the UX bar. SDK: `cwd` per session; git done by our server. Effort M.
3. **Batched line comments in diff that go back to the agent as one prompt** (Cmd+Enter). Why: turns review into a conversation instead of copy-paste. SDK: send as next user message. Effort M.
4. **Checkpoint rewind menu with three scopes (code, conversation, both) plus summarize-from-here.** Why: cheap exploration; Claude states it is for quick recovery, not VCS. SDK: file checkpointing + resume/fork (verify). Effort M. Surface the documented limits (Bash edits untracked) in the UI.
5. **Plan as an editable document with an Approve / Build step** (Cursor Markdown plan with file paths; Copilot approve-before-execute). Why: Cursor says most features start with a plan. SDK: `plan` permission mode + ExitPlanMode tool request. Effort M.
6. **Permission card showing the actual diff or command, with Allow once / Always / Deny-with-feedback.** Why: all products converge here; matches UX.md. SDK: permission callback (verify). Effort S-M.
7. **Mode switcher with Claude's five modes, remembered per folder; recommend "plan then accept edits".** SDK: permissionMode. Effort S.
8. **Side chat that reads the thread but writes nothing back.** Why: stops derailing the main session; unique to Claude Desktop. SDK: fork of session held ephemeral (verify). Effort M.
9. **Queued messages while running, with clear "sent after current action" semantics and send-now override.** Why: Claude, Cursor and Copilot all do this. SDK: streaming input (verify). Effort S.
10. **PR/CI bar: status checks, "fix CI" and "address comments" buttons, optional auto-merge.** Why: landing is half the job (GitHub's "land"; Claude's CI bar). SDK: none needed; use `gh` on our server plus an agent prompt. Effort M-L.
11. **Preview pane with a per-project `launch.json`-style config and auto-verify after edits.** Why: lets the agent check its own UI work. SDK: Bash/MCP browser tool plus hooks. Effort L.
12. **Work-start from an issue/PR and a "My Work" home view (sessions, PRs, issues).** Why: Copilot's key IA idea; makes the app the starting point of work. SDK: none; GitHub API. Effort L.
13. **Task chips: out-of-scope findings offered as one-click new sessions (own worktree).** Why: keeps sessions focused while capturing ideas. SDK: model output convention or a custom tool/MCP. Effort M.
14. **View modes (Normal / Thinking / Verbose) and a context usage ring by the model picker.** Why: one control tunes transcript density; usage is always visible. SDK: usage in result messages, thinking blocks. Effort S.
15. **Commit-to-session traceability** (session link in commit message/PR body; session logs from commits). Why: GitHub explicitly links each commit to its log for review and audit. SDK: session id. Effort S.

Honorable mentions: best-of-N across models in separate worktrees (Cursor; costly, uncertain UI); Design Mode element picker (Cursor); suggested next prompts (Claude; costs tokens); pop-out windows (fits the Electron plan); cross-session messaging (Claude; high risk).

---

## 6. Things to avoid

- **Trusting a rewind that cannot cover Bash edits or subagent edits.** Claude documents these gaps; show a warning and lean on worktrees/git for those.
- **Plan-mode state bugs.** Cursor forum reports Build dropping out of Plan mode and manual plan edits not picked up. Make "mode after approval" explicit and read the saved plan text at build time.
- **Docs ahead of product.** Cursor's worktree commands were reported missing in the new window while docs described them; "no dead buttons" in UX.md already covers this.
- **Moving surfaces.** VS Code relocated Agent Sessions between releases; keep IA stable (Claude's pane system is customizable but defaults stay put).
- **Branding.** SDK docs forbid presenting a product as "Claude Code"/Claude Code-style ASCII art; use "Claude Agent" or "Powered by Claude". The SDK docs also say third parties may not offer claude.ai login or its rate limits; use API-key auth. (Matches the `ANTHROPIC_BASE_URL` plan.)
- **Per-message cost surprises.** Copilot steering messages and Claude's prompt suggestions both consume paid requests; make background calls visible or opt-in.
- **Auto-merge and cross-session messaging by default.** Both are powerful and need explicit opt-in; Claude gates them behind settings.
- **Claiming facts from this file about Cursor/Copilot UI as verified.** They are snippet-level; confirm in the live products before copying exact interactions.

## 7. Open gaps for a follow-up (needs unrestricted network)
- Cursor: official Agents Window doc text, permission/sandbox UI, Bugbot/review specifics, queue and checkpoint docs, first-party rationale.
- GitHub: full Copilot app docs (canvas details, permission prompts, Agent Merge stop conditions), coding agent firewall page.
- Anthropic: full redesign post text (the "orchestrator" wording).
