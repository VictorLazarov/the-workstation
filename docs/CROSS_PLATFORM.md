# Cross-platform support (Windows, macOS, Linux; Chromium, Firefox, Safari/WebKit)

Supported browsers: `browserslist` in `packages/web/package.json` (Chrome 111+, Firefox 115+, Safari 16.4+; Chrome 111 not 110
because the theme uses `color-mix()`). The Vite `build.target` is derived from it (`browser-targets.ts`).
`src/lib/compat.test.ts` fails when source or built CSS/JS uses a newer feature without a recorded fallback.

Server platform code lives in `packages/server/src/platform.ts` (all functions take the platform as an argument, so
`test/platform.test.ts` exercises win32/darwin rules on Linux). Behaviour:
- Config dir: `WORKSTATION_HOME`, else `%APPDATA%\workstation` (Windows), `$XDG_CONFIG_HOME` or `~/.config/workstation`.
- Paths: containment checks are case-insensitive on Windows/macOS, drive letters/UNC aware; paths sent to the browser use `/`.
- Terminal: node-pty (ConPTY on Windows). Shell: `WORKSTATION_SHELL`, else pwsh > powershell > %COMSPEC% (Windows), `$SHELL` elsewhere.
  The python fallback is POSIX only.
- Isolated CLI home: directory junctions / file symlinks; without symlink privilege files are copied (refreshed each launch).
- `WORKSTATION_CLAUDE_PATH` selects a specific native `claude` binary (not a `.cmd` shim).

CI (`.github/workflows/ci.yml`, trigger via "Run workflow"): `node (<os>, node <20|22>)`, `e2e (chromium|firefox|webkit)`,
`e2e-smoke (macos-latest, webkit)`, `e2e-smoke (windows-latest, chromium)`. Advisory (continue-on-error, flip once green):
firefox/webkit e2e, both smoke jobs, and the Windows PTY + real-CLI server suites (tracking: never run on those runners yet).
