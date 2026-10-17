# Vision (from the owner)
A personal, extensible agentic coding harness with a first-class desktop-style UI — in the class of Claude Code
Desktop, Cursor Agents and the GitHub Copilot app — that the owner develops themselves around their daily work,
and that can connect to any provider, without settling for opencode's UI experience.

## Consequences for the design
1. **Backend is an interface, not the SDK.** The server's `sdk.ts` adapter (real / mock) is the seam. Treat it as
   an `AgentBackend` contract: start/resume/fork session, send prompt, interrupt, permission callbacks, rewind,
   model/mode/effort, MCP, history. Today's implementation = Claude Agent SDK (Anthropic-API-compatible
   endpoints, incl. gateways such as LiteLLM/OpenRouter-style proxies that speak the Anthropic Messages API).
   A future native or third-party backend must be addable without touching the web UI.
2. **UI depends on a normalized event model**, not on raw SDK shapes. Today `sdk` events are forwarded raw;
   the web reducer is the only place that interprets them, so a normalizing layer can be introduced there later.
3. **Extensibility is a feature**: keep panels, tool-card renderers, slash commands and server routes pluggable
   (registries), so the owner can add personal workflows (custom panels, review flows, task boards) quickly.
4. Everything stays local-first, single-user, token-gated.
