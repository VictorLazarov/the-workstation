import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { formatEntry, type Logger } from './log.js';
import { hostOnly, redactString } from './redact.js';

/** Version of the installed Agent SDK package (its `exports` hide package.json, so read it next to the resolved entry). */
export function sdkVersion(): string | undefined {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'));
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
      const f = path.join(dir, 'package.json');
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { name?: string; version?: string };
      if (j.name === '@anthropic-ai/claude-agent-sdk') return j.version;
    }
  } catch { /* not resolvable (bundled build) */ }
  return undefined;
}

export interface DebugInfoInput {
  appVersion: string;
  mock: boolean;
  baseUrl?: string;
  sessionId?: string;
  live?: boolean;
  model?: string;
  permissionMode?: string;
  claudeCodeVersion?: string;
  logger: Logger;
  secrets?: () => Iterable<string>;
}

/** Plain-text block for bug reports. Only host of the base URL, no credentials, no paths, no prompts; the log lines are the redacted ones. */
export function debugInfoText(i: DebugInfoInput): string {
  const host = hostOnly(i.baseUrl);
  const safe = (s: string | undefined) => (s === undefined ? undefined : redactString(s, { secrets: i.secrets?.(), maxString: 200 }));
  const lines = [
    'The Workstation debug info',
    `App version:     ${i.appVersion}${i.mock ? ' (mock mode)' : ''}`,
    `Platform:        ${os.platform()} ${os.release()} (${os.arch()})`,
    `Node:            ${process.version}`,
    `Agent SDK:       ${sdkVersion() ?? 'unknown'}${i.claudeCodeVersion ? `, Claude Code ${safe(i.claudeCodeVersion)}` : ''}`,
    `Base URL host:   ${i.baseUrl ? host ?? 'invalid URL' : 'api.anthropic.com (default)'}`,
    ...(i.sessionId ? [
      `Session:         ${safe(i.sessionId)}${i.live === false ? ' (not running)' : ''}`,
      `Model:           ${safe(i.model) ?? 'default'}`,
      `Permission mode: ${safe(i.permissionMode) ?? 'default'}`,
    ] : []),
    `Collected:       ${new Date().toISOString()}`,
    '',
  ];
  if (i.sessionId) {
    const { entries } = i.logger.entries({ sessionId: i.sessionId, limit: 50 });
    lines.push(`Last ${entries.length} log line${entries.length === 1 ? '' : 's'} of this session (redacted):`);
    for (const e of entries) lines.push(redactString(formatEntry(e), { secrets: i.secrets?.(), maxString: 2000 }));
    if (!entries.length) lines.push('(no log lines for this session)');
  }
  return lines.join('\n') + '\n';
}
