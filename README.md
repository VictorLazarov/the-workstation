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
   key empty), or put an API key in Settings. For a gateway/proxy set the **Base URL** (`ANTHROPIC_BASE_URL`) and an explicit
   model id, see [Using a gateway](#using-a-gateway-litellmopenrouter-style); only Anthropic-API-compatible endpoints work. Environment variables work too
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

## Using a gateway (LiteLLM/OpenRouter-style)
1. Settings > **Provider**: set **Anthropic base URL** to the gateway root, i.e. what the SDK extends with `/v1/messages`
   (LiteLLM: `http://localhost:4000`; an OpenRouter-style Anthropic endpoint: the base it documents, without `/v1/messages`).
   Put the gateway's key in **API key** (sent as `x-api-key`) or **Auth token** (sent as `Authorization: Bearer`).
2. **Model**: type the model id your gateway serves (verbatim: it is sent exactly as typed). With a base URL set, The Workstation
   calls `GET <base>/v1/models` (Anthropic and OpenAI-style listings) and offers what it finds in this field's list and in the
   composer's model menu, marked *from gateway*. If the gateway has no listing, type the id (or add it under *Custom model ids*).
3. **Test connection** (under the key fields): sends one 1-token message to that model with the values in the form (nothing needs
   to be saved first) and shows *Works* or the provider's own error text (`404 not_found_error: model: ...`, `401 invalid x-api-key`).
   A saved key is only reused for the saved base URL's origin; for a new URL type the key again.
4. **Gateway model aliases** (shown once a base URL is set): Claude Code also asks for its own names (Sonnet, Opus, Haiku, a
   small/fast helper for titles and summaries, subagents). Map the ones your gateway serves under another id. They are saved in the
   env the agent gets: `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
   `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` (names read from the bundled Claude Code CLI). Blank = Claude Code's default.
5. **Save**, start a session. If the gateway rejects a model, the banner names the id it rejected ("The provider does not know the
   model "..."") and offers *Choose model* (pick one: the message is sent again with it) or *Model settings* (Settings on the Model field).

Inherited credentials are never sent to the gateway (see Credential isolation): without a key, it sees `x-api-key: workstation-no-credential`.
Only gateways that speak the Anthropic Messages API work; a gateway that only speaks the OpenAI chat API needs an Anthropic-compatible front (LiteLLM provides one).

## Configuration
Config and token live in `~/.config/workstation/` (override with `WORKSTATION_HOME`; the dev container feature persists it in a volume).

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | credentials passed to the Agent SDK |
| `ANTHROPIC_BASE_URL` | custom endpoint (gateway/proxy) |
| `WORKSTATION_HOME` | config directory (the log file is `<dir>/logs/server.log`, see below) |
| `WORKSTATION_LOG_LEVEL` | lowest level written to the log file: `debug`, `info` (default), `warn`, `error`. The Logs tab keeps debug entries in memory regardless |
| `WORKSTATION_LOG_STDERR=0` | stop copying errors to the terminal the server runs in |
| `IS_SANDBOX=1` | tell Claude Code it runs in a throw-away sandbox, which enables *Bypass permissions* when running as root |
| `WORKSTATION_ALLOW_BYPASS=0` | switch *Bypass permissions* off for everyone |

These can also be set in the UI settings. **Custom endpoints:** only Anthropic-API-compatible endpoints work (they may serve any model ids), because the Agent SDK speaks the Anthropic Messages API. Other providers are out of scope.

## Where are my logs?
Open the **Logs** tab in the inspector (or `Ctrl/Cmd+K` → "Open logs", Settings → "View logs", or "View details" on any error): levels, sources and sessions are filterable, searchable, and you can copy or download what you see. **Copy debug info** (Overview → Diagnostics) gives a redacted block for bug reports.

The server also appends everything at `info` and above to a rotating file next to `config.json` (mode 0600, ~5 MB, 3 older copies kept as `server.log.1` … `.3`; set `WORKSTATION_LOG_LEVEL=debug` to write debug lines too):

| OS | Log file |
|---|---|
| Linux, macOS | `~/.config/workstation/logs/server.log` (or `$XDG_CONFIG_HOME/workstation/logs/`) |
| Windows | `%APPDATA%\workstation\logs\server.log` |
| any, with `WORKSTATION_HOME` set | `$WORKSTATION_HOME/logs/server.log` (dev containers: `/usr/local/share/workstation-config/logs/server.log`) |

`tail -f` it, or `npm start` prints its path on startup. Keys, tokens, `Authorization` headers and `?token=` values are removed before anything is written; prompts and file contents are never logged. Clearing the log in the UI empties only the in-memory view, not the file.

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
