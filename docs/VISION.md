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
