# The Workstation

A desktop-style workspace for coding agents that runs in your browser, built on the Claude Agent SDK. Parallel sessions with live status, rich tool cards, inline permission and plan review, diff review and commit, files, terminal and MCP panels, and a custom `ANTHROPIC_BASE_URL`. Run it locally or install it into any devcontainer.

New here? Read [docs/PRODUCT.md](docs/PRODUCT.md) for the vision, principles and roadmap.

Your `CLAUDE.md`, skills, hooks, MCP servers and `settings.json` behave as in the CLI (user, project and local settings are loaded).

## Quickstart

### Local
Requires Node >= 20.
```bash
git clone https://github.com/VictorLazarov/the-workstation && cd the-workstation
npm ci && npm run build
npm start            # opens http://localhost:7777/?token=...
```
Or the installer (pinned to a release tag; read it before running): `curl -fsSLO https://raw.githubusercontent.com/VictorLazarov/the-workstation/v0.1.0/scripts/install.sh && bash install.sh`, then `workstation`.

Flags: `--host <addr>` (default `127.0.0.1`), `--port <n>` (default `7777`), `--no-open` (don't launch a browser).

### Dev Container
```jsonc
{
  "features": { "ghcr.io/victorlazarov/the-workstation/workstation:1": {} },
  "forwardPorts": [7777],
  "portsAttributes": { "7777": { "label": "The Workstation", "onAutoForward": "notify" } },
  "remoteEnv": { "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}" }
}
```
The server autostarts on `127.0.0.1` (VS Code / Codespaces forwarding works); run `workstation-url` to get the tokenized URL. Full options: [docs/DEVCONTAINER.md](docs/DEVCONTAINER.md).

### Docker
`docker compose up --build` then open the URL printed in the logs.

## Configuration
Config and token live in `~/.config/workstation/` (override with `WORKSTATION_HOME`; the dev container feature persists it in a volume).

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | credentials passed to the Agent SDK |
| `ANTHROPIC_BASE_URL` | custom endpoint (gateway/proxy) |
| `WORKSTATION_HOME` | config directory |

These can also be set in the UI settings. **Custom endpoints:** only Anthropic-API-compatible endpoints serving Claude
models work, because the Agent SDK speaks the Anthropic Messages API. Other providers are out of scope.

## Security model
The server can run shell commands and edit files as its user, so access control is the whole game.
- A random token is generated on first start and stored in `config.json` (mode 0600). Every REST and WebSocket request needs it.
- Default bind is `127.0.0.1`: only local processes can connect.
- `Origin`/`Host` are checked to block DNS-rebinding and cross-site WebSocket hijacking.
- The dev container feature also binds `127.0.0.1` (VS Code / Codespaces forward via localhost inside the container). Bind
  `0.0.0.0` (feature option `host`, or `--host`) only for `docker run -p`; that is still token-gated, but treat the URL as a
  password: anyone holding it controls your container.
- The web UI talks only to the server it was loaded from. Another server can only be chosen in Settings, behind a confirm
  that names it; nothing in a URL can redirect the token. Only same-origin browser requests (or `WORKSTATION_ALLOWED_ORIGINS`)
  are accepted, so other local ports (dev servers) cannot drive the API.
- With a custom endpoint/key/token configured, Claude Code runs with an isolated config dir and environment, so your own
  Claude login, `apiKeyHelper` and inherited `ANTHROPIC_*` variables never reach that endpoint (docs/ARCHITECTURE.md).
- The integrated terminal is your own shell, not a sandbox: it can read `config.json` like any file of your user.
- Forward ports safely: publish as `127.0.0.1:7777:7777` (Docker), keep VS Code / Codespaces ports **private** (never "Public"), and
  prefer an SSH tunnel or an authenticating reverse proxy with TLS for remote machines. Don't expose plain HTTP to the internet.
- Rotate the token by deleting `config.json` (or the config volume) and restarting. Don't paste tokenized URLs into chats or logs.

## Development
```bash
npm ci
npm run dev          # server with watch (tsx)
npm run build        # protocol, web, server
npm run typecheck
npm test
WORKSTATION_MOCK=1 npm start   # mock SDK, no API key needed
```
Layout: `packages/protocol` (shared types), `packages/server` (HTTP+WS, Agent SDK), `packages/web` (React SPA),
`devcontainer/` (Feature). `scripts/test-feature.sh` smoke-tests the feature installer offline. CI: `.github/workflows/`.

## Roadmap
See the phased scope (P0/P1/P2) in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
