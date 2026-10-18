# Using The Workstation in a Container

Three supported ways, all exercised by `scripts/test-devcontainer.sh` against a real Docker daemon (see
[Testing](#testing) and [What is verified](#what-is-verified)):

1. the **Dev Container Feature** (`devcontainer/src/workstation`), for any devcontainer image;
2. the root **`Dockerfile` / `docker-compose.yml`**, a standalone image;
3. `scripts/install.sh`, for any shell with Node >= 20 (a VM, a plain container).

## Quick start: Dev Container Feature
```jsonc
// .devcontainer/devcontainer.json  (also in devcontainer/examples/devcontainer.json)
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "ghcr.io/victorlazarov/the-workstation/workstation:1": {}
  },
  "forwardPorts": [7777],
  "portsAttributes": { "7777": { "label": "The Workstation", "onAutoForward": "notify" } },
  "remoteEnv": {
    "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}",
    "ANTHROPIC_BASE_URL": "${localEnv:ANTHROPIC_BASE_URL}"
  }
}
```
**Until the owner publishes the `v0.1.0` release tag** the feature's default `version` does not exist: add
`"version": "<branch-or-full-commit-sha>"` to the feature's options (`"ghcr.io/victorlazarov/the-workstation/workstation:1": { "version": "<sha>" }`).
The feature image itself (`ghcr.io/...:1`) is also only available once the release procedure below has been run; before that use
`source=local` or the Docker/installer routes.

Reopen in the container, then in a terminal inside it:
```bash
workstation-url        # The Workstation: http://127.0.0.1:7777/?token=...   (open it through the forwarded port)
```
The node feature is optional: without it (or without a Node >= 20 in the image) the installer downloads the official
Node tarball from nodejs.org and verifies its SHA256 (see "Options" below).

`forwardPorts`/`portsAttributes` are **not** valid inside a feature (the spec does not allow them), so they live in your
`devcontainer.json`. Use `"onAutoForward": "openBrowser"` to open the UI automatically.

On every container start the feature runs `workstation-autostart` (postStartCommand), which starts the server in the
background and waits until the port answers. The tokenized sign-in URL is **not** printed into the postStart log (those
logs are often pasted into bug reports); it is written to `$WORKSTATION_HOME/url` (mode 0600) and `workstation-url`
prints it. Set `"printUrl": true` to print it on start anyway. Server log (also contains the URL):
`$WORKSTATION_HOME/server.log`, inside the 0700 config dir.

Without VS Code, with the reference CLI (`npm i -g @devcontainers/cli`):
```bash
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . workstation-url
```

## Bind address: `127.0.0.1` (default) vs `0.0.0.0`
| `host` | Works with | Trade-off |
|---|---|---|
| `127.0.0.1` (default) | VS Code / Codespaces / devcontainer CLI port forwarding (they connect to `localhost` inside the container) | Not reachable through `docker run -p` / `appPort`, nor from other containers or the network. Safest. |
| `0.0.0.0` | `docker run -p`, `appPort`, other containers on the same network | Reachable by anything that can reach the container (still token-gated, Host/Origin-checked). Publish as `127.0.0.1:PORT:7777` so only your machine can connect. |

Verified: with `host=127.0.0.1` a published port (`appPort`) does **not** reach the server (connection reset); with
`host=0.0.0.0` it does, a request without the token gets `401`, with the token `200`, and a forged `Host:` header `403`.
To publish:
```jsonc
"features": { "ghcr.io/victorlazarov/the-workstation/workstation:1": { "host": "0.0.0.0" } },
"appPort": ["127.0.0.1:7777:7777"]
```
Keep forwarded ports **private** in Codespaces. Browsing through a forwarded hostname other than `localhost` (e.g.
Codespaces' `*.app.github.dev`) needs `WORKSTATION_ALLOWED_HOSTS`/`WORKSTATION_ALLOWED_ORIGINS` set to that host/origin.

## Options
| Option | Default | Meaning |
|---|---|---|
| `source` | `git` | `git` (clone `sourceUrl` @ `version`, build), `npm` (package `sourceUrl`, default `workstation`, at `version`; **the package is not published yet**), `tarball` (source archive URL in `sourceUrl`, built), `local` (bind-mounted checkout at `localPath`) |
| `version` | `v0.1.0` | release tag, or a full 40-char commit SHA (most reproducible; verified after checkout). **The default tag does not exist until the owner pushes it: set `"version": "<branch-or-full-sha>"` explicitly until then.** Branches float. npm: package version (a leading `v` is stripped) |
| `sourceUrl` | _(empty)_ | repo URL / npm package name / tarball URL |
| `localPath` | `/workspaces/the-workstation` | `source=local`: where the checkout lives; built on first start if `dist` is missing |
| `port` | `7777` | listen port |
| `host` | `127.0.0.1` | bind address (see the table above) |
| `autostart` | `true` | start on container start |
| `printUrl` | `false` | also print the tokenized URL in the postStart output |
| `installClaudeCode` | `false` | `npm i -g @anthropic-ai/claude-code@<claudeCodeVersion>` (the Agent SDK bundles its own runtime; this only adds the `claude` CLI for the terminal / `claude login`) |
| `claudeCodeVersion` | `2.1.302` | exact CLI version (the one bundled by the SDK this release uses); ranges/tags are rejected |
| `nodeVersion` | `22` | Node major installed if Node >= 20 is absent: official nodejs.org `.tar.gz`, SHA256-checked against that release's `SHASUMS256.txt` (Alpine: the distro `nodejs` package). Recommended: add `ghcr.io/devcontainers/features/node` instead |

What the installer puts into the image: Node (only if missing), `python3` + `make` + a C++ compiler **if missing**
(node-pty, the terminal module, has no Linux prebuilds and is compiled by npm; without the toolchain npm silently skips
it and the TypeScript build fails), the app under `/usr/local/share/workstation`, and the commands `workstation`,
`workstation-url`, `workstation-autostart` in `/usr/local/bin`.

Supply chain: no `curl | bash`; the app is built from the pinned tag/commit with `npm ci` (lockfile integrity);
`source=tarball` downloads are not checksum-verified, prefer `git` with a commit SHA. The SHA256 check of the Node
tarball protects against corruption and mirror tampering, not against a compromised nodejs.org (no GPG check).

### Developing The Workstation itself in a container (`source=local`)
`"source": "local", "localPath": "/workspaces/the-workstation"` runs the checkout that is mounted there. `${containerWorkspaceFolder}`
is not substitutable inside feature options, so use the literal path. The first start runs `npm ci && npm run build`
**inside the mount, as the remote user**: this replaces the checkout's `node_modules` with Linux binaries. Do not
bind-mount a macOS/Windows host checkout you also use natively; clone into the container (or use a named volume for
`node_modules`) instead. The first postStart takes a few minutes while it builds (progress: `$WORKSTATION_HOME/server.log`).

## Persistence
The feature sets `WORKSTATION_HOME=/usr/local/share/workstation-config` and mounts a named volume
`workstation-config-${devcontainerId}` there, so the token and settings survive rebuilds (verified: same token after
`devcontainer up --remove-existing-container`). For non-root remote users, `~/.config/workstation` is symlinked to it.
Delete the volume (`docker volume rm workstation-config-...`) to rotate the token.

## Logs
Diagnostics (session start/stop, API errors with status and request id, the agent CLI's stderr, permission decisions, git and
worktree failures, REST errors) are written to `$WORKSTATION_HOME/logs/server.log`, i.e.
`/usr/local/share/workstation-config/logs/server.log` with the feature. It rotates at ~5 MB and keeps 3 older copies, and it is on the persisted volume, so it survives rebuilds:

```bash
tail -f "${WORKSTATION_HOME:-$HOME/.config/workstation}/logs/server.log"
docker exec <container> tail -f /usr/local/share/workstation-config/logs/server.log   # from the host
```
`$WORKSTATION_HOME/server.log` (next to it, not inside `logs/`) is only the launcher's stdout/stderr (build progress, crashes
before the server starts). The same entries are in the app: inspector → **Logs**. Secrets are redacted before they are written.

## Running as root: Bypass permissions
Claude Code refuses `--dangerously-skip-permissions` when it runs as root/sudo unless it is inside a deliberate sandbox. Many
devcontainers and plain Docker images run as root, so The Workstation only enables **Bypass permissions** when the server is
non-root, or `IS_SANDBOX=1` (or `CLAUDE_CODE_BUBBLEWRAP`) is set in the environment the server starts with. Otherwise:

* normal sessions work (ask / auto-accept edits / plan / auto);
* the *Bypass permissions* entry in the mode menu is disabled with the reason, `Shift+Tab` and the command palette skip it, and
  `/api/health` reports `bypassPermissions: { available: false, reason }`;
* a saved default mode of "Bypass permissions" quietly falls back to "Ask permissions", and an explicit request for it is
  refused with an explanation (not a cryptic "process exited with code 1").

To use it: run as a non-root user (`remoteUser` in `devcontainer.json`, `USER` in the image), or, in a container you consider
disposable, set `"containerEnv": { "IS_SANDBOX": "1" }` (or `IS_SANDBOX=1 workstation`). `WORKSTATION_ALLOW_BYPASS=0` turns the
mode off everywhere. (Verified against the real SDK as root: sessions run without `IS_SANDBOX`; with it bypass is offered.)

## Credentials / custom endpoints
**Gateway (LiteLLM/OpenRouter-style) in a container**: set `ANTHROPIC_BASE_URL` (and the key) via `remoteEnv`/`containerEnv`, or in Settings. From
inside a container `localhost` is the container: use `host.docker.internal` (Docker Desktop) or the gateway's service name on the compose network.
Then in Settings choose an explicit **Model** id (the list is filled from `GET <base>/v1/models`), press **Test connection**, and map the
Sonnet/Opus/Haiku/small-fast/subagent aliases if the gateway serves them under other ids (they land in `ANTHROPIC_DEFAULT_*_MODEL`,
`ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`). Full steps: README "Using a gateway".

Pass `ANTHROPIC_API_KEY` and optionally `ANTHROPIC_BASE_URL` via `remoteEnv` as above (or `containerEnv`). Only
Anthropic-API-compatible endpoints serving Claude models work with the Agent SDK. You can also set them in the UI
settings. Note `remoteEnv` is applied to processes started by the tool, so the autostart server sees it in recent
devcontainer CLI/VS Code; if not, set them via `containerEnv` or the UI. Without credentials the UI works and a prompt
ends with "Not logged in" (the bundled `claude` binary starts; that is what the automated test checks).

## Standalone image: Docker / Compose
```bash
docker compose up --build              # first build: a few minutes (compiles node-pty)
docker compose logs workstation        # prints  http://127.0.0.1:7777/?token=...   (the port inside the container)
```
* Publishes `127.0.0.1:7777` only; change the host port with `WORKSTATION_PORT=7780 docker compose up`.
* Runs as the non-root `node` user (uid 1000). The project is `./` bind-mounted at `/workspace`. If your host uid is not
  1000 (Linux), run as yourself so files and git ownership match:
  `export WORKSTATION_UID=$(id -u) WORKSTATION_GID=$(id -g); docker compose up --build`.
* `/config` is a named volume (`workstation-config`): the token survives `docker compose down` / rebuilds
  (`docker compose down -v` rotates it).
* Plain Docker: `docker build -t workstation . && docker run --rm -p 127.0.0.1:7777:7777 -v ws-config:/config -v "$PWD:/workspace" workstation`.
* Build arguments: `NODE_IMAGE` (default `node:22-bookworm-slim`), `EXTRA_APT` (default `ripgrep`).
* The image has a `HEALTHCHECK` (`docker ps` shows `healthy`).
* The server listens on `0.0.0.0` inside the container (required for a published port); the token still gates `/api` and
  the WebSockets. Never publish it on `0.0.0.0` of a shared network without a reverse proxy that adds TLS.

## Other ways to install
`curl -fsSLO https://raw.githubusercontent.com/VictorLazarov/the-workstation/<ref>/scripts/install.sh`, read it, then
`WORKSTATION_REF=<ref> bash install.sh` (`WORKSTATION_REPO` selects another remote). `<ref>` must exist: no release tag
(`v0.1.0`) is published until the owner pushes it, so use a branch (default `main`) or a full commit SHA, e.g.
`REF=$(git rev-parse HEAD)`. The simplest alternative is `git clone` + `npm ci && npm run build && npm start`. Needs git, Node >= 20 and, on
Linux, `python3 make g++` (it prints the install command if the build fails because they are missing).

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `could not check out 'v0.1.0' from ...` during the build | The release tag does not exist yet (or is private). Set the `version` option to an existing branch or a full commit SHA, e.g. `"workstation": { "version": "<sha>" }`. |
| Every session fails with `--dangerously-skip-permissions cannot be used with root/sudo` | Fixed: update. Bypass is now only offered when allowed, see [Running as root](#running-as-root-bypass-permissions). |
| Build fails with `Cannot find module 'node-pty'` | The native toolchain is missing (an older installer, or `scripts/install.sh` on a bare machine): install `python3 make g++` and rebuild. The feature installs them itself. |
| `Failed to download package for ghcr.io/...` | The registry/package is unreachable or private. After the first publish make the package public (see Release). Behind a TLS-inspecting proxy the proxy CA must be trusted by Docker and the CLI. |
| Browser shows a blank/403 page through Codespaces/remote forwarding | Host header not allowed: set `WORKSTATION_ALLOWED_HOSTS` / `WORKSTATION_ALLOWED_ORIGINS` (`containerEnv`) to the forwarded host. |
| Port published with `-p` / `appPort` is reset or empty | The server is bound to `127.0.0.1` inside the container: set the feature option `"host": "0.0.0.0"` (and publish as `127.0.0.1:7777:7777`). |
| `workstation-url` says "URL not available yet" | The server is not running: `cat $WORKSTATION_HOME/server.log`; start it with `workstation-autostart`. Once it runs, details are in `$WORKSTATION_HOME/logs/server.log` and the Logs tab (see [Logs](#logs)). |
| First start of a `source=local` container is slow / "building checkout" | `npm ci && npm run build` runs once inside the mount; follow `$WORKSTATION_HOME/server.log`. `WORKSTATION_START_TIMEOUT` (seconds, default 900) bounds the wait. |
| `EACCES` writing config in the compose setup | The container user cannot write the volume or project: set `WORKSTATION_UID`/`WORKSTATION_GID` as above. |
| `Permission denied` on `/usr/local/share/workstation-config/server.log` at start (feature) | The devcontainer tooling renumbered the remote user to your host uid (`updateRemoteUserUID`) after the feature chowned the config volume. The launcher and `workstation-autostart` take the volume over with `sudo -n chown` automatically; without sudo run `sudo chown -R $(id -u) /usr/local/share/workstation-config` once. |
| `fatal: detected dubious ownership` in the terminal of the **feature** container | Bind-mounted workspace owned by another uid: `git config --global --add safe.directory '*'` (the standalone image sets this system-wide). |
| Terminal says "No pseudo-terminal backend" | node-pty did not build and `python3` is missing: install `python3 make g++`, `npm rebuild node-pty` in the app directory. |

## Release procedure
Two independent artifacts, in this order:

1. **App release tag** (what the feature's default `version` and `scripts/install.sh` point to).
   ```bash
   git tag -a v0.1.0 -m "The Workstation 0.1.0" && git push origin v0.1.0
   ```
   The tag must exist before the feature is used with its defaults; otherwise installs fail with "could not check out".
   Until then, pin a commit SHA (`"version": "<40 hex>"`).
2. **Feature publish** to GHCR (`.github/workflows/release-feature.yml`, uses `devcontainers/action` and the built-in
   `GITHUB_TOKEN`; no secrets). Bump `version` in `devcontainer/src/workstation/devcontainer-feature.json`
   (semver; consumers using `:1` get every 1.x), merge, then
   ```bash
   git tag feature-v1.1.0 && git push origin feature-v1.1.0     # or run the workflow manually
   ```
   It publishes `ghcr.io/<owner>/<repo>/workstation` with tags `1`, `1.1`, `1.1.0`, `latest`.
3. **First publish only**: GitHub > your profile/org > Packages > `the-workstation/workstation` > Package settings >
   Change visibility > **Public** (and, for a private repo, link the package to the repository). Anonymous pulls then work:
   `devcontainer features info manifest ghcr.io/<owner>/<repo>/workstation:1` should print the manifest.
4. Update the `ghcr.io/...` references in `README.md`, `devcontainer/examples/devcontainer.json` and this file if the
   owner/repo name differs from `victorlazarov/the-workstation` (GHCR paths are lower-case).
5. Smoke-test the published artifact from a clean machine (this part cannot run before the first publish):
   `devcontainer up --workspace-folder <dir with the README snippet>`, then `devcontainer exec ... workstation-url`.

## Testing
```bash
scripts/test-feature.sh                       # offline smoke of install.sh with a stub repo (no Docker, seconds)
scripts/test-devcontainer.sh                  # everything below against a real Docker daemon (~25 min)
scripts/test-devcontainer.sh --stage features git-ubuntu tarball     # chosen feature scenarios
scripts/test-devcontainer.sh --stage up       # devcontainer up: loopback vs 0.0.0.0 + published port, rebuild persistence
scripts/test-devcontainer.sh --stage image    # Dockerfile + docker-compose.yml
scripts/test-devcontainer.sh --stage installer  # scripts/install.sh as a normal user in a clean container
```
How it works: no release tag is needed. The script snapshots the current working tree (committed or not) into a throw-away
git repository, tags it with the feature's default version, serves it with `git daemon` on the host and renders
`devcontainer/test/workstation/scenarios.json` (placeholders `@GIT_URL@`, `@GIT_SHA@`, `@TARBALL_URL@`, `@LOCAL_CHECKOUT@`,
`@IMG:<image>@`) into a temporary project for `devcontainer features test`. Each scenario runs
`devcontainer/test/workstation/<scenario>.sh` inside the built container as the remote user; the shared black-box checker is
`probe.mjs` (SPA, auth, WebSocket, mock-mode session, git worktree, PTY terminal, and the real SDK's bundled `claude` binary).

Scenarios: `git-ubuntu` (no Node in the image: tarball Node path; default tag), `git-node` (Debian image with Node and
non-root `node` user), `git-debian` (no Node and no python3 in the image), `git-alpine` (musl: apk Node + toolchain), `tarball`, `local-mount`,
`bind-all-interfaces` (`host=0.0.0.0`), `autostart-off`, `claude-code-cli`.

Environment knobs (full list in the script header): `DEVCONTAINER_CLI`, `WS_TEST_WORKDIR`, `WS_TEST_KEEP=1` (keep logs),
`WS_TEST_HOST_ADDR` (how containers reach the host; default the docker bridge gateway), `WS_TEST_CA_BUNDLE` (extra CA for a
TLS-intercepting proxy; every base image is wrapped in a derived image that trusts it), `WS_TEST_PRUNE=1` (free disk between
scenarios), `WS_TEST_SKIP`, `WS_TEST_NODE_IMAGE`/`WS_TEST_EXTRA_APT` (Dockerfile build args when apt mirrors are unreachable).

CI (`.github/workflows/ci.yml`): job `feature` (shellcheck + offline smoke) and the matrix job `devcontainer` (seven parallel
slices of the script on `ubuntu-latest`, which ships Docker).

## What is verified
What the automated tests assert **inside a real container** (all green on the authoring machine except where the next list says
it could not run): install on Ubuntu (no Node), Debian-based `javascript-node` (Node present, user `node`), Debian, tarball, `local`
(bind mount, first-start build), `host=0.0.0.0`, `autostart=false`, `installClaudeCode`; `workstation --help`; autostart on
`127.0.0.1:7777`; `workstation-url` tokenized URL; config volume persists across `devcontainer up --remove-existing-container`;
SPA served with a CSP; `/api/health` 401 without a token and 200 with; WebSocket 401/403 without token / with a foreign origin;
mock-mode session round trip; git worktree create/remove; PTY terminal (node-pty compiled in the image); non-root remote user;
the bundled `claude` binary launches (init + "Not logged in" without credentials); published port from the docker host with
token enforcement; Dockerfile image and compose (non-root, arbitrary uid, volume persistence, healthcheck).

**Not verified (honest list):**
* Pulling the feature **from GHCR** (`ghcr.io/victorlazarov/...`): it is not published yet, and the authoring sandbox blocks
  GHCR blob downloads. Also the `ghcr.io/devcontainers/features/node` feature could not be pulled there. CI/first publish decide.
* **`git-debian`** (plain `devcontainers/base:debian`, which has no python3) could not run in the authoring sandbox because the Debian mirrors are unresolvable there; the same apt path is exercised by `git-ubuntu` (apt) there and by CI.
* **Alpine / musl** end to end in the authoring sandbox (its egress policy blocks `dl-cdn.alpinelinux.org`); the scenario
  exists and runs in CI, the `apk` branch of `install.sh` was only reviewed, not executed.
* The Dockerfile's own `apt-get` steps on `node:22-bookworm-slim` (Debian mirrors are unreachable from the sandbox; it was built on
  the devcontainers `javascript-node:22` image via `NODE_IMAGE`/`EXTRA_APT=`). CI builds the default.
* **Real model calls** from inside a container (no credentials in the test environment; only the launch and the auth error are asserted).
* `source=npm` (the npm package is not published).
* **VS Code** (Dev Containers extension), **GitHub Codespaces** (port forwarding hostnames, `ALLOWED_HOSTS`), **Docker Desktop on
  macOS / Windows** (bind-mount performance and permissions, `host.docker.internal`), rootless Docker/Podman, arm64 images.
* Corporate TLS-inspecting proxies beyond what the test CA mechanism covers.
