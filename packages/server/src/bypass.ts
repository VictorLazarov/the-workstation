/**
 * Can "Bypass permissions" be offered at all? The Claude Code CLI refuses `--dangerously-skip-permissions` (which the SDK
 * passes for `allowDangerouslySkipPermissions` / bypassPermissions) when it runs as root, unless it is inside a deliberate
 * sandbox (IS_SANDBOX=1 or CLAUDE_CODE_BUBBLEWRAP). If we passed the flag anyway, EVERY session on a root devcontainer
 * would die at startup (scrutiniser pass 5, M1). So: only pass it when allowed, and tell the UI when it is not.
 */
export interface BypassCapability { available: boolean; reason?: string }

export const BYPASS_ROOT_REASON =
  'Bypass permissions is unavailable: the server runs as root, and Claude Code refuses to skip permission prompts as root. '
  + 'Run the server as a non-root user, or set IS_SANDBOX=1 if this is a throw-away sandbox (see docs/DEVCONTAINER.md).';

export const BYPASS_OFF_REASON = 'Bypass permissions is switched off on this server (WORKSTATION_ALLOW_BYPASS=0).';

/** `env` is the environment the CLI will get; `server` is the server's own (for the WORKSTATION_ALLOW_BYPASS switch). */
export function bypassCapability(env: Record<string, string | undefined> = process.env, uid: number | undefined = process.getuid?.(), server: Record<string, string | undefined> = process.env): BypassCapability {
  if (server.WORKSTATION_ALLOW_BYPASS === '0') return { available: false, reason: BYPASS_OFF_REASON };
  const root = uid === 0;
  if (!root) return { available: true };
  if (env.IS_SANDBOX === '1' || (env.CLAUDE_CODE_BUBBLEWRAP && env.CLAUDE_CODE_BUBBLEWRAP !== '0')) return { available: true };
  return { available: false, reason: BYPASS_ROOT_REASON };
}
