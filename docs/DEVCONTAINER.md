# Using The Workstation in a Dev Container

## Quick start
Replace `OWNER` with the GitHub owner/repo that publishes the feature (see "Publishing").

```jsonc
// .devcontainer/devcontainer.json  (also in devcontainer/examples/devcontainer.json)
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "ghcr.io/OWNER/the-workstation/workstation:1": {}
  },
  "forwardPorts": [7777],
  "portsAttributes": { "7777": { "label": "The Workstation", "onAutoForward": "notify" } },
  "remoteEnv": {
    "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}",
    "ANTHROPIC_BASE_URL": "${localEnv:ANTHROPIC_BASE_URL}"
  }
}
```

`forwardPorts`/`portsAttributes` are **not** valid inside a feature (the spec does not allow them), so they live
in your `devcontainer.json`. Use `"onAutoForward": "openBrowser"` to open the UI automatically.

On every container start the feature runs `workstation-autostart` (postStartCommand), which starts the server in the
background and prints `The Workstation: http://localhost:7777/?token=...`. Re-print it any time with `workstation-url`.
Server log: `$WORKSTATION_HOME/server.log`.

## Options
| Option | Default | Meaning |
|---|---|---|
| `source` | `git` | `git` (clone `sourceUrl` @ `version`, build), `npm` (package `sourceUrl`, default `workstation`, at `version`), `tarball` (source archive URL in `sourceUrl`, built), `local` (bind-mounted checkout at `localPath`) |
| `version` | `main` | git ref / npm version (`main` means `latest` for npm) |
| `sourceUrl` | _(empty)_ | repo URL / npm package name / tarball URL |
| `localPath` | `/workspaces/the-workstation` | `source=local`: where the checkout lives; built on first start if `dist` is missing |
| `port` | `7777` | listen port |
| `host` | `0.0.0.0` | bind address (token-gated; see README security section) |
| `autostart` | `true` | start on container start |
| `installClaudeCode` | `true` | `npm i -g @anthropic-ai/claude-code` (the Agent SDK bundles its own runtime; this gives you the `claude` CLI/`claude login`) |
| `nodeVersion` | `22` | Node major installed if Node >= 20 is absent |

Developing The Workstation itself in a container: `"source": "local", "localPath": "${containerWorkspaceFolder}"` is
not substitutable inside feature options, so use the literal path, e.g. `/workspaces/the-workstation`.

## Persistence
The feature sets `WORKSTATION_HOME=/usr/local/share/workstation-config` and mounts a named volume
`workstation-config-${devcontainerId}` there, so the token and settings survive rebuilds. For non-root remote users,
`~/.config/workstation` is symlinked to it. Delete the volume to rotate the token.

## Credentials / custom endpoints
Pass `ANTHROPIC_API_KEY` and optionally `ANTHROPIC_BASE_URL` via `remoteEnv` as above (or `containerEnv` for the
build-time container). Only Anthropic-API-compatible endpoints serving Claude models work with the Agent SDK.
You can also set them in the UI settings. Note `remoteEnv` is applied to processes started by the tool, so the
autostart server sees it in recent devcontainer CLI/VS Code; if not, set them via `containerEnv` or the UI.

## Other ways to install
- Any container/VM: `curl -fsSL https://raw.githubusercontent.com/OWNER/the-workstation/main/scripts/install.sh | bash`
- Standalone: `docker compose up --build` (see `Dockerfile`, `docker-compose.yml`).

## Publishing the feature
`.github/workflows/release-feature.yml` uses `devcontainers/action` and the built-in `GITHUB_TOKEN`; no extra secrets.
Bump `version` in `devcontainer/src/workstation/devcontainer-feature.json`, push a tag `feature-v*` (or run the workflow
manually). It publishes `ghcr.io/<owner>/<repo>/workstation`. After the first publish make the package public in
GitHub Packages. Before first use replace the `OWNER` placeholders (feature json, `install.sh`, `scripts/install.sh`,
README, examples).

## Testing
- `scripts/test-feature.sh`: offline smoke test of `install.sh` in a scratch prefix with a stub repo (no root/Docker).
- CI runs `devcontainer features test` (real container build) on GitHub runners.
