# The Workstation

A desktop-style workspace for coding agents that runs in your browser, built on the Claude Agent SDK. Parallel sessions with live status, rich tool cards, inline permission and plan review, diff review and commit, files, terminal and MCP panels, and a custom `ANTHROPIC_BASE_URL`. Run it locally or install it into any devcontainer.

New here? Read [docs/PRODUCT.md](docs/PRODUCT.md) for the vision, principles and roadmap.

Your `CLAUDE.md`, skills, hooks, MCP servers and `settings.json` behave as in the CLI (user, project and local settings are loaded).

## Quickstart

### Local (the supported path)
Requires Node >= 20, git, and (Linux) `python3 make g++` for the terminal's `node-pty`.
```bash
git clone https://github.com/VictorLazarov/the-workstation && cd the-workstation
npm ci && npm run build
npm start            # prints http://127.0.0.1:7777/?token=... and opens it
```

### Installer script and Dev Container Feature (need a ref that exists)
Both build the app from a git **ref** (a release tag, a branch or a full commit SHA). No release tag has been published yet,
so the `v0.1.0` default of the Feature (and any `.../v0.1.0/...` URL) does not resolve until the owner pushes that tag. Until then
name a branch or commit explicitly:
```bash
REF=<branch-or-full-commit-sha>        # e.g. the branch you cloned, or: git rev-parse HEAD
curl -fsSLO https://raw.githubusercontent.com/VictorLazarov/the-workstation/$REF/scripts/install.sh
less install.sh && WORKSTATION_REF=$REF bash install.sh      # then: workstation
```
For the Feature set the option `"version": "<branch-or-full-commit-sha>"` (see [docs/DEVCONTAINER.md](docs/DEVCONTAINER.md)).
A commit SHA is the most reproducible; a branch floats.

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
The server autostarts on `127.0.0.1` (VS Code / Codespaces forwarding works); run `workstation-url` in the container to get the tokenized URL. The feature installs Node, a C++ toolchain (for the terminal's `node-pty`) and the app if the image lacks them. Plain `docker run -p` needs `"host": "0.0.0.0"`. Options, troubleshooting, release procedure and what is verified: [docs/DEVCONTAINER.md](docs/DEVCONTAINER.md).

### Docker
```bash
docker compose up --build        # publishes 127.0.0.1:7777 only; ./ is mounted as /workspace
docker compose logs workstation  # the sign-in URL with the token
```
Runs as a non-root user; on Linux with a host uid other than 1000 first `export WORKSTATION_UID=$(id -u) WORKSTATION_GID=$(id -g)`. See [docs/DEVCONTAINER.md](docs/DEVCONTAINER.md#standalone-image-docker--compose).

## First 10 minutes
1. **Install and start**: the three Local commands above. Leave the terminal open; it prints the URL once, e.g.
   `http://127.0.0.1:7777/?token=...` (also in `~/.config/workstation/config.json`). Treat the URL like a password.
2. **Open the URL** (it opens itself unless `--no-open`). The first run shows Settings.
3. **Provider**: the app does not log you in. Either you are already signed in with Claude Code on this machine (leave the
   key empty), or put an API key in Settings. For a gateway/proxy set the **Base URL** (`ANTHROPIC_BASE_URL`); only
   Anthropic-API-compatible endpoints serving Claude models work. Environment variables work too
   (`ANTHROPIC_API_KEY=... npm start`).
4. **Open a project**: *Open project* (`Ctrl/Cmd O`) and pick a folder (a git repo gives you Changes, commit and worktrees).
5. **First session**: type a task in the composer. `@` mentions a file, `/` lists commands and skills (Enter runs one that
   needs no argument), `Shift+Tab` cycles permission modes. Approve or deny the permission cards as they appear; sessions that
   need you are marked *Needs input* in the sidebar.
6. **Review**: open the inspector (`Ctrl/Cmd Alt B`) > Changes: read each diff, click a line to comment, *Send to agent*,
   then *Commit*. Commit needs a git name and email (`git config --global user.name ...`; the app tells you if they are missing).
   *Rewind* on a message restores files from before it.
7. **Parallel work**: tick *New git worktree* on a new session to give it its own branch and checkout.
8. **Shortcuts**: `Ctrl/Cmd K` command palette (every action, session and panel, e.g. "Open terminal"), `Ctrl/Cmd /` the full list.

Running as root (typical in Docker/devcontainers)? Everything works except *Bypass permissions*, which Claude Code refuses as
root unless `IS_SANDBOX=1` is set; the mode is shown disabled with the reason. See [docs/DEVCONTAINER.md](docs/DEVCONTAINER.md#running-as-root-bypass-permissions).

## Configuration
Config and token live in `~/.config/workstation/` (override with `WORKSTATION_HOME`; the dev container feature persists it in a volume).

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | credentials passed to the Agent SDK |
| `ANTHROPIC_BASE_URL` | custom endpoint (gateway/proxy) |
| `WORKSTATION_HOME` | config directory |
| `IS_SANDBOX=1` | tell Claude Code it runs in a throw-away sandbox, which enables *Bypass permissions* when running as root |
| `WORKSTATION_ALLOW_BYPASS=0` | switch *Bypass permissions* off for everyone |

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
`devcontainer/` (Feature). `scripts/test-feature.sh` smoke-tests the feature installer offline; `scripts/test-devcontainer.sh` builds and
tests the Feature, the Dockerfile and docker-compose.yml in real containers (needs Docker). CI: `.github/workflows/`.

## Roadmap
See the phased scope (P0/P1/P2) in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
