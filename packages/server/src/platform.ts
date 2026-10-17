/**
 * Platform helpers (Windows / macOS / Linux). Everything that depends on the OS takes the platform (and the
 * `path` flavour / env / fs probes) as an argument so tests can exercise the win32 and darwin logic on Linux.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PathApi = typeof path.posix;

export const pathFor = (platform: NodeJS.Platform = process.platform): PathApi => (platform === 'win32' ? path.win32 : path.posix);

/** Windows and macOS (APFS/HFS+ default) volumes are case-insensitive. */
export const isCaseInsensitiveFs = (platform: NodeJS.Platform = process.platform): boolean => platform === 'win32' || platform === 'darwin';

/** `a\b` -> `a/b` on Windows; unchanged on POSIX (where a backslash is a legal file-name character). */
export function toPosix(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.split('\\').join('/') : p;
}

/** Path from git output (`/`-separated, `C:/x` on Windows) -> native form. */
export function fromGitPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).normalize(p);
}

const lower = (s: string) => s.toLowerCase();

/**
 * `target` relative to `root` (native separators) or null when it is not inside (or equal to) root. On case-insensitive
 * platforms the comparison ignores case (so `C:\Repo\a` is inside `c:\repo`), while the returned remainder keeps the
 * target's own spelling. Handles drive letters / UNC through the injected `path` flavour.
 */
export function relativeInside(root: string, target: string, platform: NodeJS.Platform = process.platform): string | null {
  const p = pathFor(platform);
  const ci = isCaseInsensitiveFs(platform);
  const r = p.resolve(root);
  const t = p.resolve(target);
  // win32 path.relative is already case-insensitive; posix (macOS) needs the lower-cased comparison
  const rel = ci ? p.relative(lower(r), lower(t)) : p.relative(r, t);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) return null;
  if (!ci) return rel;
  // keep the target's spelling: take the same number of trailing segments from the original string
  const n = rel.split(p.sep).length;
  const segs = t.split(p.sep);
  return segs.slice(segs.length - n).join(p.sep);
}

export const isInside = (root: string, target: string, platform: NodeJS.Platform = process.platform): boolean => relativeInside(root, target, platform) !== null;

/** Same file-system location by name (case-insensitive on Windows/macOS, separators normalised). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathFor(platform);
  const x = p.resolve(a), y = p.resolve(b);
  return isCaseInsensitiveFs(platform) ? lower(x) === lower(y) : x === y;
}

/**
 * realpath that also canonicalises case and expands 8.3 short names (`RUNNER~1`) on Windows/macOS (`realpath.native`), which the JS implementation does not. Falls back to the JS version.
 * (`fs.promises.realpath` is already native.)
 */
export function realpathSyncNative(p: string): string {
  try { return fs.realpathSync.native(p); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw e;
    return fs.realpathSync(p);
  }
}
/**
 * True when a path segment names the `.git` directory on this file system: case-insensitive on Windows/macOS, and on
 * Windows also `.git.`, `.git ` and NTFS alternate-stream spellings (`.git::$INDEX_ALLOCATION`) which open the same directory.
 */
export function isGitDirName(seg: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return seg.split(':')[0]!.replace(/[. ]+$/, '').toLowerCase() === '.git';
  return isCaseInsensitiveFs(platform) ? seg.toLowerCase() === '.git' : seg === '.git';
}

/** Win32 device / extended-length namespaces (`\\.\\pipe\\x`, `\\?\\C:\\x`): never accepted as user-supplied project paths. */
export const isWindowsDevicePath = (p: string): boolean => /^[\\/]{2}[.?][\\/]/.test(p);

/** `~`, `~/x`, `~\x` -> home-relative path. */
export function expandHome(p: string, home = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || (platform === 'win32' && p.startsWith('~\\'))) return pathFor(platform).join(home, p.slice(2));
  return p;
}

/** Case-insensitive env lookup on Windows (`Path` vs `PATH`), exact elsewhere. */
export function getEnv(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return env[name];
  if (env[name] !== undefined) return env[name];
  const want = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === want) return env[k];
  return undefined;
}

/** Directories on PATH (any casing of the variable on Windows). */
export function pathDirs(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string[] {
  const v = getEnv(env, 'PATH', platform) ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  return v.split(sep).map((s) => (platform === 'win32' ? s.replace(/^"(.*)"$/, '$1') : s)).filter(Boolean);
}

/** Resolve an executable on PATH honouring PATHEXT on Windows. `exists` is injectable for tests. */
export function which(
  cmd: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (f: string) => boolean = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } },
): string | null {
  const p = pathFor(platform);
  const exts = platform === 'win32' ? (getEnv(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasExt = platform === 'win32' && exts.some((e) => lower(cmd).endsWith(lower(e)));
  const names = platform === 'win32' ? (hasExt ? [cmd] : exts.map((e) => cmd + e)) : [cmd];
  const dirs = p.isAbsolute(cmd) || cmd.includes('/') || (platform === 'win32' && cmd.includes('\\')) ? [''] : pathDirs(env, platform);
  for (const d of dirs) for (const n of names) {
    const f = d ? p.join(d, n) : n;
    if (exists(f)) return f;
  }
  return null;
}

/**
 * Default interactive shell for the integrated terminal. WORKSTATION_SHELL overrides everywhere.
 * Windows: pwsh (PowerShell 7) > Windows PowerShell > %COMSPEC% (cmd). macOS: $SHELL > /bin/zsh. Linux: $SHELL > bash > sh.
 */
export function defaultShell(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, exists: (f: string) => boolean = fs.existsSync): string {
  const override = getEnv(env, 'WORKSTATION_SHELL', platform);
  if (override && (exists(override) || which(override, env, platform))) return override;
  if (platform === 'win32') {
    const sh = getEnv(env, 'SHELL', platform);
    if (sh && path.win32.isAbsolute(sh) && exists(sh)) return sh; // Git Bash / MSYS users who set SHELL
    for (const c of ['pwsh.exe', 'powershell.exe']) { const w = which(c, env, platform, exists); if (w) return w; }
    return getEnv(env, 'COMSPEC', platform) || 'cmd.exe';
  }
  const sh = getEnv(env, 'SHELL', platform);
  if (sh && exists(sh)) return sh;
  if (platform === 'darwin' && exists('/bin/zsh')) return '/bin/zsh';
  return exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** Arguments that start `shell` interactively (cmd.exe has no `-i`; PowerShell wants -NoLogo). */
export function shellArgs(shell: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['-i'];
  const base = path.win32.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return ['-NoLogo'];
  if (base === 'cmd') return [];
  return ['-i']; // bash.exe / zsh.exe from Git for Windows, MSYS2, WSL
}

/** Command that opens `url` in the default browser without going through a shell (no quoting pitfalls with `&`). */
export function openBrowserCommand(url: string, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  const browser = env.BROWSER;
  if (browser && !browser.includes(' ') && !browser.includes(':')) return { cmd: browser, args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** Config directory: %APPDATA%\workstation on Windows, $XDG_CONFIG_HOME or ~/.config elsewhere. WORKSTATION_HOME wins. */
export function configDirFor(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  const override = getEnv(env, 'WORKSTATION_HOME', platform);
  if (override) return override;
  const p = pathFor(platform);
  if (platform === 'win32') return p.join(getEnv(env, 'APPDATA', platform) || p.join(home, 'AppData', 'Roaming'), 'workstation');
  const xdg = env.XDG_CONFIG_HOME;
  return p.join(xdg && p.isAbsolute(xdg) ? xdg : p.join(home, '.config'), 'workstation');
}

/** Directory of an ES module as a native path (`new URL(..).pathname` yields `/C:/x` on Windows). */
export const moduleDir = (importMetaUrl: string): string => path.dirname(fileURLToPath(importMetaUrl));

export interface KillDeps {
  platform?: NodeJS.Platform;
  execFile?: (cmd: string, args: string[], cb: (err: Error | null) => void) => void;
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
}

/**
 * Terminate a process and its children. Windows has no POSIX signals: `taskkill /T /F` ends the tree. POSIX: SIGTERM to the
 * process group when `group` (the child was started detached), else to the process; SIGKILL escalation is the caller's job.
 */
export function killProcessTree(pid: number, opts: { group?: boolean; signal?: NodeJS.Signals } & KillDeps = {}): void {
  const platform = opts.platform ?? process.platform;
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    const run = opts.execFile ?? ((cmd, args, cb) => { execFile(cmd, args, { windowsHide: true }, (err) => cb(err)); });
    run('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* already gone */ });
    return;
  }
  const kill = opts.kill ?? ((p, s) => process.kill(p, s));
  try { kill(opts.group ? -pid : pid, opts.signal ?? 'SIGTERM'); } catch { /* gone */ }
}

/** fs.renameSync that retries the transient EPERM/EBUSY/EACCES Windows raises while antivirus/indexers hold the target. */
export function renameWithRetry(from: string, to: string, rename: (a: string, b: string) => void = fs.renameSync, attempts = 6): void {
  for (let i = 0; ; i++) {
    try { return rename(from, to); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= attempts - 1 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (i + 1));
    }
  }
}

/** Write `data` privately (0600 where the OS has mode bits) via temp file + rename. */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try { renameWithRetry(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows: mode bits are not a thing */ }
}

let warnedShim = false;
/**
 * `WORKSTATION_CLAUDE_PATH` -> SDK `pathToClaudeCodeExecutable`. By default the SDK uses the native `claude` binary shipped in its
 * per-platform optional package (claude.exe on Windows). A `.cmd`/`.bat` npm shim cannot be started without a shell (Node >= 20.12
 * refuses to spawn them with shell:false, CVE-2024-27980), so those are ignored with a warning: point at claude.exe instead.
 */
export function claudeExecutableOption(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): { pathToClaudeCodeExecutable?: string } {
  const p = getEnv(env, 'WORKSTATION_CLAUDE_PATH', platform);
  if (!p) return {};
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(p)) {
    if (!warnedShim) { warnedShim = true; console.warn('[workstation] WORKSTATION_CLAUDE_PATH points at a .cmd/.bat shim, which cannot be spawned without a shell; ignoring it (use the native claude.exe).'); }
    return {};
  }
  return { pathToClaudeCodeExecutable: p };
}
