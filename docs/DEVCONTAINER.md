# Using The Workstation in a Dev Container

## Quick start
```jsonc
// .devcontainer/devcontainer.json  (also in devcontainer/examples/devcontainer.json)
{
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "ghcr.io/VictorLazarov/the-workstation/workstation:1": {}
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
background. The tokenized sign-in URL is **not** printed into the postStart log (those logs are often pasted into bug
reports); it is written to `$WORKSTATION_HOME/url` (mode 0600) and `workstation-url` prints it. Set `"printUrl": true` to
print it on start anyway. Server log (also contains the URL): `$WORKSTATION_HOME/server.log`, inside the 0700 config dir.

## Bind address: `127.0.0.1` (default) vs `0.0.0.0`
| `host` | Works with | Trade-off |
|---|---|---|
| `127.0.0.1` (default) | VS Code / Codespaces / devcontainer CLI port forwarding (they connect to `localhost` inside the container) | Not reachable from other containers or the network. Safest. |
| `0.0.0.0` | `docker run -p 7777:7777`, `appPort`, other containers on the same network | Reachable by anything that can reach the container (still token-gated, Host/Origin-checked). Publish as `-p 127.0.0.1:7777:7777` so only your machine can connect. |

Only switch to `0.0.0.0` when the forwarded port does not reach the server (plain Docker port publishing). Keep forwarded
ports **private** in Codespaces. Browsing through a forwarded hostname other than `localhost` (e.g. Codespaces'
`*.app.github.dev`) needs `WORKSTATION_ALLOWED_HOSTS`/`WORKSTATION_ALLOWED_ORIGINS` set to that host/origin.

## Options
| Option | Default | Meaning |
|---|---|---|
| `source` | `git` | `git` (clone `sourceUrl` @ `version`, build), `npm` (package `sourceUrl`, default `workstation`, at `version`), `tarball` (source archive URL in `sourceUrl`, built), `local` (bind-mounted checkout at `localPath`) |
| `version` | `v0.1.0` | release tag, or a full 40-char commit SHA (most reproducible; verified after checkout). Branches such as `main` float: avoid. npm: package version (a leading `v` is stripped) |
| `sourceUrl` | _(empty)_ | repo URL / npm package name / tarball URL |
| `localPath` | `/workspaces/the-workstation` | `source=local`: where the checkout lives; built on first start if `dist` is missing |
| `port` | `7777` | listen port |
| `host` | `127.0.0.1` | bind address (see the table above) |
| `autostart` | `true` | start on container start |
| `printUrl` | `false` | also print the tokenized URL in the postStart output |
| `installClaudeCode` | `false` | `npm i -g @anthropic-ai/claude-code@<claudeCodeVersion>` (the Agent SDK bundles its own runtime; this only adds the `claude` CLI for the terminal / `claude login`) |
| `claudeCodeVersion` | `2.1.302` | exact CLI version (the one bundled by the SDK this release uses); ranges/tags are rejected |
| `nodeVersion` | `22` | Node major installed if Node >= 20 is absent: official nodejs.org `.tar.gz`, SHA256-checked against that release's `SHASUMS256.txt` (fails with a pointer to the node feature otherwise). Recommended: add `ghcr.io/devcontainers/features/node` instead |

Supply chain: no `curl | bash`; the app is built from the pinned tag/commit with `npm ci` (lockfile integrity);
`source=tarball` downloads are not checksum-verified, prefer `git` with a commit SHA. The SHA256 check of the Node
tarball protects against corruption and mirror tampering, not against a compromised nodejs.org (no GPG check).

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
- Any container/VM: `curl -fsSLO https://raw.githubusercontent.com/VictorLazarov/the-workstation/v0.1.0/scripts/install.sh`, read it, then `bash install.sh` (`WORKSTATION_REF` selects a tag/commit)
- Standalone: `docker compose up --build` (see `Dockerfile`, `docker-compose.yml`).

## Publishing the feature
`.github/workflows/release-feature.yml` uses `devcontainers/action` and the built-in `GITHUB_TOKEN`; no extra secrets.
Bump `version` in `devcontainer/src/workstation/devcontainer-feature.json`, push a tag `feature-v*` (or run the workflow
manually). It publishes `ghcr.io/<owner>/<repo>/workstation`. After the first publish make the package public in
GitHub Packages. **Before publishing, push the app release tag that the feature's `version` default points to**
(currently `v0.1.0`), otherwise the default `source=git` install fails with a clear "could not check out" error.

## Testing
- `scripts/test-feature.sh`: offline smoke test of `install.sh` in a scratch prefix with a stub repo (no root/Docker).
- CI runs `devcontainer features test` (real container build) on GitHub runners.
