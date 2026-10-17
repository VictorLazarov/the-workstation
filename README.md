# The Workstation

A desktop-style workspace for coding agents that runs in your browser, built on the Claude Agent SDK. Parallel sessions with live status, rich tool cards, inline permission and plan review, diff review and commit, files, terminal and MCP panels, and a custom `ANTHROPIC_BASE_URL`. Run it locally or install it into any devcontainer.

New here? Read [docs/PRODUCT.md](docs/PRODUCT.md) for the vision, principles and roadmap.

Your `CLAUDE.md`, skills, hooks, MCP servers and `settings.json` behave as in the CLI (user, project and local settings are loaded).

## Quickstart

### Local
Requires Node >= 20.
```bash
git clone https://github.com/OWNER/the-workstation && cd the-workstation
npm ci && npm run build
npm start            # opens http://localhost:7777/?token=...
```
Or the one-liner installer: `curl -fsSL https://raw.githubusercontent.com/OWNER/the-workstation/main/scripts/install.sh | bash`, then `workstation`.

Flags: `--host <addr>` (default `127.0.0.1`), `--port <n>` (default `7777`), `--no-open` (don't launch a browser).

### Dev Container
```jsonc
{
  "features": { "ghcr.io/OWNER/the-workstation/workstation:1": {} },
  "forwardPorts": [7777],
  "portsAttributes": { "7777": { "label": "The Workstation", "onAutoForward": "notify" } },
  "remoteEnv": { "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}" }
}
```
The server autostarts and prints the tokenized URL (`workstation-url` reprints it). Full options: [docs/DEVCONTAINER.md](docs/DEVCONTAINER.md).

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
- In containers the server binds `0.0.0.0` because port forwarding connects from outside the container's loopback. That is still
  token-gated, but treat the URL as a password: anyone holding it controls your container.
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
