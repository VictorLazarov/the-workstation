/**
 * Cross-platform logic exercised on any host by injecting the platform (path.win32 / darwin rules, fake env, fake fs probes).
 * What these cannot prove (real ConPTY, real NTFS, real APFS) is covered by the CI matrix (.github/workflows/ci.yml).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolatedBaseEnv, linkEntry, prepareCliHome } from '../src/cli-env.js';
import {
  claudeExecutableOption, configDirFor, defaultShell, expandHome, fromGitPath, getEnv, isGitDirName, isInside, isWindowsDevicePath, killProcessTree,
  moduleDir, openBrowserCommand, pathDirs, relativeInside, renameWithRetry, samePath, shellArgs, toPosix, which,
} from '../src/platform.js';
import { sanitizeEnv } from '../src/terminal.js';

describe('path containment (repo-root check, resolveInRepo)', () => {
  it('win32: drive letters and case-insensitive, separators normalised', () => {
    expect(relativeInside('C:\\Repo', 'c:\\repo\\Src\\a.ts', 'win32')).toBe('Src\\a.ts'); // keeps the target spelling
    expect(relativeInside('C:\\Repo', 'C:/Repo/src/a.ts', 'win32')).toBe('src\\a.ts');
    expect(relativeInside('C:\\Repo', 'C:\\Repo', 'win32')).toBe('');
    expect(relativeInside('C:\\Repo', 'C:\\Repo2\\x', 'win32')).toBeNull(); // prefix is not containment
    expect(relativeInside('C:\\Repo', 'D:\\Repo\\x', 'win32')).toBeNull(); // other drive
    expect(relativeInside('C:\\Repo', 'C:\\Repo\\..\\Other', 'win32')).toBeNull();
    expect(relativeInside('C:\\Repo', 'C:\\Repo\\a\\..\\..\\x', 'win32')).toBeNull();
  });
  it('win32: UNC roots', () => {
    expect(relativeInside('\\\\srv\\share\\r', '\\\\SRV\\SHARE\\R\\x\\y', 'win32')).toBe('x\\y');
    expect(relativeInside('\\\\srv\\share\\r', '\\\\srv\\other\\r\\x', 'win32')).toBeNull();
  });
  it('win32: long and spaced paths', () => {
    const root = 'C:\\Users\\Jane Doe\\My Projects\\' + 'deep\\'.repeat(60);
    expect(relativeInside(root, root + 'file name.txt', 'win32')).toBe('file name.txt');
  });
  it('darwin: case-insensitive (APFS default) with a case-sensitive POSIX path module', () => {
    expect(relativeInside('/Users/Me/Repo', '/users/me/repo/Src/a.ts', 'darwin')).toBe('Src/a.ts');
    expect(relativeInside('/Users/Me/Repo', '/Users/Me/Repo-other/a', 'darwin')).toBeNull();
    expect(relativeInside('/Users/Me/Repo', '/Users/Me/Repo/../x', 'darwin')).toBeNull();
  });
  it('linux: case-sensitive', () => {
    expect(relativeInside('/home/u/Repo', '/home/u/repo/a', 'linux')).toBeNull();
    expect(relativeInside('/home/u/Repo', '/home/u/Repo/a/b', 'linux')).toBe('a/b');
    expect(isInside('/home/u/Repo', '/home/u/Repo', 'linux')).toBe(true);
  });
  it('samePath ignores case only where the file system does', () => {
    expect(samePath('C:\\Proj', 'c:/proj/', 'win32')).toBe(true);
    expect(samePath('/Users/Me/p', '/users/me/P', 'darwin')).toBe(true);
    expect(samePath('/home/u/p', '/home/u/P', 'linux')).toBe(false);
  });
  it('.git is recognised under every spelling the file system aliases', () => {
    expect(isGitDirName('.git', 'linux')).toBe(true);
    expect(isGitDirName('.GIT', 'linux')).toBe(false);
    expect(isGitDirName('.GIT', 'darwin')).toBe(true);
    for (const n of ['.git', '.GIT', '.git.', '.git ', '.git::$INDEX_ALLOCATION']) expect(isGitDirName(n, 'win32')).toBe(true);
    expect(isGitDirName('.github', 'win32')).toBe(false);
    expect(isGitDirName('.gitignore', 'win32')).toBe(false);
  });
});

describe('path conversion', () => {
  it('git prints C:/x; the server uses native separators and sends / to the browser', () => {
    expect(fromGitPath('C:/Users/x/my repo', 'win32')).toBe('C:\\Users\\x\\my repo');
    expect(toPosix('C:\\Users\\x\\my repo\\a.ts', 'win32')).toBe('C:/Users/x/my repo/a.ts');
    expect(toPosix('/a/b\\c', 'linux')).toBe('/a/b\\c'); // backslash is a legal POSIX file-name character
  });
  it('expands ~ with both separators on Windows', () => {
    expect(expandHome('~', 'C:\\Users\\x', 'win32')).toBe('C:\\Users\\x');
    expect(expandHome('~\\a', 'C:\\Users\\x', 'win32')).toBe('C:\\Users\\x\\a');
    expect(expandHome('~/a', 'C:\\Users\\x', 'win32')).toBe('C:\\Users\\x\\a');
    expect(expandHome('~\\a', '/home/x', 'linux')).toBe('~\\a');
    expect(expandHome('~/a', '/home/x', 'linux')).toBe('/home/x/a');
  });
  it('rejects Windows device / extended-length namespaces', () => {
    for (const p of ['\\\\.\\pipe\\x', '\\\\?\\C:\\x', '//./C:/x', '//?/C:/x']) expect(isWindowsDevicePath(p)).toBe(true);
    for (const p of ['C:\\x', '\\\\srv\\share', '/home/x']) expect(isWindowsDevicePath(p)).toBe(false);
  });
  it('moduleDir returns a native directory', () => {
    expect(moduleDir(new URL('file:///tmp/a/b.js').href)).toBe(path.dirname('/tmp/a/b.js'));
  });
});

describe('env var case-insensitivity', () => {
  const winEnv = { Path: 'C:\\Windows\\System32;"C:\\Program Files\\Git\\cmd"', PathExt: '.COM;.EXE;.CMD', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  it('getEnv finds Path on win32, is exact elsewhere', () => {
    expect(getEnv(winEnv, 'PATH', 'win32')).toBe(winEnv.Path);
    expect(getEnv(winEnv, 'PATH', 'linux')).toBeUndefined();
    expect(pathDirs(winEnv, 'win32')).toEqual(['C:\\Windows\\System32', 'C:\\Program Files\\Git\\cmd']);
  });
  it('isolated CLI env keeps Windows essentials under any casing, drops credentials and case-duplicates', () => {
    const base = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', PathExt: '.EXE', UserProfile: 'C:\\Users\\x', AppData: 'C:\\a', 'ProgramFiles(x86)': 'C:\\pf', Temp: 'C:\\t', Https_Proxy: 'http://p:1',
      Anthropic_Api_Key: 'sk-x', github_token: 'ghp', Aws_Profile: 'p', ProxyWithPw: 'x', http_proxy: 'http://u:pw@p:1', MY_TOOL_HOME: 'C:\\tool' };
    const env = isolatedBaseEnv(base as NodeJS.ProcessEnv, false, 'win32');
    expect(env).toMatchObject({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', PathExt: '.EXE', UserProfile: 'C:\\Users\\x', AppData: 'C:\\a', 'ProgramFiles(x86)': 'C:\\pf', Temp: 'C:\\t', Https_Proxy: 'http://p:1', MY_TOOL_HOME: 'C:\\tool' });
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY']));
    expect(env.Anthropic_Api_Key).toBeUndefined();
    expect(env.github_token).toBeUndefined();
    expect(env.Aws_Profile).toBeUndefined();
    expect(env.http_proxy).toBeUndefined(); // credentials in the proxy URL
    // strict mode: only the base allowlist (+ Windows essentials)
    const strict = isolatedBaseEnv(base as NodeJS.ProcessEnv, true, 'win32');
    expect(strict.MY_TOOL_HOME).toBeUndefined();
    expect(strict.Path).toBe('C:\\bin');
    expect(strict['ProgramFiles(x86)']).toBe('C:\\pf');
  });
  it('POSIX stays case-sensitive (a `path` variable is not PATH)', () => {
    expect(isolatedBaseEnv({ path: '/x', PATH: '/bin' }, true, 'linux')).toEqual({ PATH: '/bin' });
  });
  it('terminal env removes server variables regardless of case', () => {
    const e = sanitizeEnv({ Workstation_Home: '/h', anthropic_api_key: 'k', Claude_Code_Entrypoint: 'x', GH_TOKEN: 'user', Path: 'p' } as NodeJS.ProcessEnv, 'srv-token');
    expect(e).not.toHaveProperty('Workstation_Home');
    expect(e).not.toHaveProperty('anthropic_api_key');
    expect(e).not.toHaveProperty('Claude_Code_Entrypoint');
    expect(e).toMatchObject({ GH_TOKEN: 'user', Path: 'p', TERM: 'xterm-256color' });
  });
});

describe('locating executables (git / claude / shells)', () => {
  const winEnv = { Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\PowerShell\\7', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const files = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\cmd.exe']);
  // NTFS is case-insensitive: so is the fake
  const exists = (f: string) => [...files].some((x) => x.toLowerCase() === f.toLowerCase());
  it('which honours PATHEXT on win32', () => {
    expect(which('git', winEnv, 'win32', exists)?.toLowerCase()).toBe('c:\\program files\\git\\cmd\\git.exe');
    expect(which('git.exe', winEnv, 'win32', exists)).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(which('nope', winEnv, 'win32', exists)).toBeNull();
    expect(which('git', { PATH: '/usr/bin:/bin' }, 'linux', (f) => f === '/bin/git')).toBe('/bin/git');
  });
  it('default shell: Windows prefers pwsh, then powershell, then COMSPEC; POSIX uses $SHELL', () => {
    expect(defaultShell(winEnv, 'win32', exists)).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    files.delete('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(defaultShell({ ...winEnv, Path: winEnv.Path + ';C:\\Windows\\System32\\WindowsPowerShell\\v1.0' }, 'win32', exists)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(defaultShell(winEnv, 'win32', exists)).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(defaultShell({ Path: 'C:\\nothing' }, 'win32', () => false)).toBe('cmd.exe');
    expect(defaultShell({ SHELL: '/bin/fish' }, 'linux', (f) => f === '/bin/fish')).toBe('/bin/fish');
    expect(defaultShell({}, 'linux', (f) => f === '/bin/bash')).toBe('/bin/bash');
    expect(defaultShell({}, 'linux', () => false)).toBe('/bin/sh');
    expect(defaultShell({}, 'darwin', (f) => f === '/bin/zsh')).toBe('/bin/zsh');
    expect(defaultShell({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin', () => true)).toBe('/opt/homebrew/bin/fish');
    expect(defaultShell({ WORKSTATION_SHELL: '/usr/bin/zsh', SHELL: '/bin/bash' }, 'linux', () => true)).toBe('/usr/bin/zsh');
  });
  it('shell arguments: cmd has no -i, PowerShell wants -NoLogo', () => {
    expect(shellArgs('C:\\Windows\\System32\\cmd.exe', 'win32')).toEqual([]);
    expect(shellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toEqual(['-NoLogo']);
    expect(shellArgs('powershell.exe', 'win32')).toEqual(['-NoLogo']);
    expect(shellArgs('C:\\Program Files\\Git\\bin\\bash.exe', 'win32')).toEqual(['-i']);
    expect(shellArgs('/bin/zsh', 'darwin')).toEqual(['-i']);
  });
  it('WORKSTATION_CLAUDE_PATH: native path honoured, .cmd shim ignored on Windows', () => {
    expect(claudeExecutableOption({}, 'linux')).toEqual({});
    expect(claudeExecutableOption({ WORKSTATION_CLAUDE_PATH: '/opt/claude' }, 'linux')).toEqual({ pathToClaudeCodeExecutable: '/opt/claude' });
    expect(claudeExecutableOption({ WORKSTATION_CLAUDE_PATH: 'C:\\x\\claude.exe' }, 'win32')).toEqual({ pathToClaudeCodeExecutable: 'C:\\x\\claude.exe' });
    expect(claudeExecutableOption({ WORKSTATION_CLAUDE_PATH: 'C:\\npm\\claude.cmd' }, 'win32')).toEqual({});
  });
});

describe('browser launch and config location', () => {
  it('open / rundll32 (no shell, so `&` in a URL is safe) / xdg-open / $BROWSER', () => {
    const u = 'http://localhost:7777/?token=a&b=c';
    expect(openBrowserCommand(u, 'darwin')).toEqual({ cmd: 'open', args: [u] });
    expect(openBrowserCommand(u, 'win32')).toEqual({ cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', u] });
    expect(openBrowserCommand(u, 'linux', {})).toEqual({ cmd: 'xdg-open', args: [u] });
    expect(openBrowserCommand(u, 'linux', { BROWSER: 'firefox' })).toEqual({ cmd: 'firefox', args: [u] });
    expect(openBrowserCommand(u, 'linux', { BROWSER: 'a b' })).toEqual({ cmd: 'xdg-open', args: [u] });
  });
  it('config dir: WORKSTATION_HOME > %APPDATA% (win32) / $XDG_CONFIG_HOME / ~/.config', () => {
    expect(configDirFor({ WORKSTATION_HOME: 'D:\\ws' }, 'win32', 'C:\\Users\\x')).toBe('D:\\ws');
    expect(configDirFor({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32', 'C:\\Users\\x')).toBe('C:\\Users\\x\\AppData\\Roaming\\workstation');
    expect(configDirFor({}, 'win32', 'C:\\Users\\x')).toBe('C:\\Users\\x\\AppData\\Roaming\\workstation');
    expect(configDirFor({}, 'darwin', '/Users/x')).toBe('/Users/x/.config/workstation');
    expect(configDirFor({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/x')).toBe('/xdg/workstation');
    expect(configDirFor({ XDG_CONFIG_HOME: 'relative' }, 'linux', '/home/x')).toBe('/home/x/.config/workstation');
  });
});

describe('process kill semantics', () => {
  it('Windows: taskkill /T /F (no POSIX signals)', () => {
    const calls: Array<[string, string[]]> = [];
    killProcessTree(1234, { platform: 'win32', execFile: (c, a, cb) => { calls.push([c, a]); cb(null); }, kill: () => { throw new Error('must not signal'); } });
    expect(calls).toEqual([['taskkill', ['/pid', '1234', '/T', '/F']]]);
  });
  it('POSIX: SIGTERM to the process, or to the group when detached', () => {
    const sent: Array<[number, unknown]> = [];
    killProcessTree(77, { platform: 'linux', kill: (p, s) => { sent.push([p, s]); } });
    killProcessTree(77, { platform: 'darwin', group: true, kill: (p, s) => { sent.push([p, s]); } });
    killProcessTree(77, { platform: 'linux', signal: 'SIGKILL', kill: (p, s) => { sent.push([p, s]); } });
    expect(sent).toEqual([[77, 'SIGTERM'], [-77, 'SIGTERM'], [77, 'SIGKILL']]);
  });
  it('ignores a gone process and bad pids', () => {
    expect(() => killProcessTree(5, { platform: 'linux', kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); } })).not.toThrow();
    killProcessTree(0, { platform: 'win32', execFile: () => { throw new Error('no'); } });
    killProcessTree(NaN, { platform: 'linux', kill: () => { throw new Error('no'); } });
  });
});

describe('atomic config writes on Windows (EPERM/EBUSY while an indexer holds the file)', () => {
  it('retries transient errors, gives up on others', () => {
    let n = 0;
    renameWithRetry('a', 'b', () => { if (++n < 3) throw Object.assign(new Error('busy'), { code: n === 1 ? 'EPERM' : 'EBUSY' }); });
    expect(n).toBe(3);
    expect(() => renameWithRetry('a', 'b', () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); })).toThrow('nope');
    let m = 0;
    expect(() => renameWithRetry('a', 'b', () => { m++; throw Object.assign(new Error('stuck'), { code: 'EPERM' }); }, 3)).toThrow('stuck');
    expect(m).toBe(3);
  });
});

describe('isolated CLI home without symlink privilege (Windows)', () => {
  let root: string;
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' }); };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-link-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const setup = () => {
    const src = path.join(root, 'user-claude');
    fs.mkdirSync(path.join(src, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(src, 'CLAUDE.md'), 'v1');
    fs.writeFileSync(path.join(src, '.credentials.json'), '{"secret":1}');
    fs.writeFileSync(path.join(src, 'settings.json'), '{"apiKeyHelper":"x","theme":"dark"}');
    return { src, dir: path.join(root, 'cli-home'), global: path.join(root, 'none.json') };
  };

  it('linkEntry: junction for directories and symlink for files on win32; copy fallback only for files', () => {
    const { src } = setup();
    const calls: Array<[string, string | undefined]> = [];
    const ok = (_t: string, p: string, type?: string) => { calls.push([path.basename(p), type]); };
    expect(linkEntry(path.join(src, 'skills'), path.join(root, 'l-skills'), { platform: 'win32', symlink: ok })).toBe('junction');
    expect(linkEntry(path.join(src, 'CLAUDE.md'), path.join(root, 'l-md'), { platform: 'win32', symlink: ok })).toBe('symlink');
    expect(calls).toEqual([['l-skills', 'junction'], ['l-md', 'file']]);
    expect(linkEntry(path.join(src, 'skills'), path.join(root, 'l2'), { platform: 'win32', symlink: eperm })).toBe('skipped'); // live data is never copied
    expect(linkEntry(path.join(src, 'CLAUDE.md'), path.join(root, 'l3'), { platform: 'win32', symlink: eperm })).toBe('copy');
    expect(fs.readFileSync(path.join(root, 'l3'), 'utf8')).toBe('v1');
  });

  it('prepareCliHome degrades to a refreshed copy of CLAUDE.md, never copies credentials, and does not throw', () => {
    const { src, dir, global } = setup();
    prepareCliHome(dir, src, global, { platform: 'win32', symlink: eperm });
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('v1');
    expect(fs.existsSync(path.join(dir, 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.credentials.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
    // the user edits CLAUDE.md: the next launch refreshes our copy
    fs.writeFileSync(path.join(src, 'CLAUDE.md'), 'v2');
    prepareCliHome(dir, src, global, { platform: 'win32', symlink: eperm });
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('v2');
    // privilege appears later (Developer Mode switched on): the copy is replaced by a link
    prepareCliHome(dir, src, global, { platform: 'win32', symlink: (t, p) => fs.symlinkSync(t, p) });
    expect(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('a file the CLI itself created is left alone', () => {
    const { src, dir, global } = setup();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'cli-owned');
    prepareCliHome(dir, src, global, { platform: 'win32', symlink: eperm });
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('cli-owned');
  });

  it('chmod failures (Windows has no mode bits) do not break preparation', () => {
    const { src, dir, global } = setup();
    const orig = fs.chmodSync;
    (fs as { chmodSync: unknown }).chmodSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    try { expect(() => prepareCliHome(dir, src, global)).not.toThrow(); } finally { (fs as { chmodSync: unknown }).chmodSync = orig; }
  });
});
