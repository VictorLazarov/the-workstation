# Vision (from the owner)
A personal, extensible coding-agent workspace — in the class of Claude Code Desktop, Cursor Agents and the GitHub
Copilot app — that the owner shapes around their daily work. The **Claude Agent SDK is the engine** ("best in the
business"); we do not reinvent the agent loop, tools, permissions, sessions, MCP, hooks, skills or checkpoints.
Our value is the UX/UI and workflows built on top of it. Provider flexibility = `ANTHROPIC_BASE_URL` / gateways
speaking the Anthropic API; no custom agent runtime.

## Consequences for the design
1. **Lean on the SDK for everything it offers** (sessions, resume/fork, rewind, MCP, skills, subagents, hooks,
   settings sources, usage/context). Before building any feature, check whether the SDK already provides it and
   expose that rather than reimplementing.
2. **No speculative backend abstraction.** The mock in `packages/server/src/sdk.ts` exists only for tests/demo.
3. **Invest in the UI**: rich tool rendering, parallel sessions, review/diff workflow, composer, polish (see UX.md).
4. **Extensibility at the UI layer**: panels, tool-card renderers and commands are registries so the owner can add
   personal workflows quickly.
5. Local-first, single-user, token-gated.

## Portability rule (why it's a web app)
The browser UI exists so the same app ports to Electron/Tauri/PWA with minimal effort. Therefore:
- The web app talks to the server only via `/api` + `/ws`, with a configurable server base URL (default: same
  origin) and token — no cookies, no server-side rendering, no reliance on same-site tricks.
- Any native-ish capability (open folder dialog, notifications, open-in-editor, reveal-in-finder, clipboard,
  deep links) goes through a small `platform` adapter in the web app with a browser implementation now and an
  Electron implementation later. Never call Electron/Node APIs from UI components.
- The server must be launchable programmatically (`startServer()` exists) so an Electron main process can embed
  it on a random free port with a generated token, bind 127.0.0.1 only.
- An `apps/desktop` Electron shell (main process: start server, open window, native menus, dialog adapter) is a
  planned wave-3 deliverable; it should be a thin wrapper of well under a few hundred lines.
