import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger, RingBuffer, RotatingFile, formatEntry, parseLogFilter } from '../src/log.js';
import { REDACTED, hostOnly, isSecretName, redactEnv, redactString, redactValue } from '../src/redact.js';
import { createStderrLogger, logMcpStatus, logSdkMessage, requestIdIn } from '../src/sdk-log.js';
import { debugInfoText } from '../src/diagnostics.js';
import { logFileFor } from '../src/platform.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws-log-'));
const mk = (o: ConstructorParameters<typeof Logger>[0] = {}) => new Logger({ stderr: false, ...o });

describe('RingBuffer', () => {
  it('keeps the newest N, oldest first', () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
  });
  it('clear empties and reports the count; pushing works afterwards', () => {
    const r = new RingBuffer<number>(3);
    r.push(1); r.push(2);
    expect(r.clear()).toBe(2);
    expect(r.toArray()).toEqual([]);
    r.push(9);
    expect(r.toArray()).toEqual([9]);
  });
  it('rejects a bad capacity', () => { expect(() => new RingBuffer(0)).toThrow(); });
});

describe('Logger', () => {
  it('numbers entries, keeps the ring bounded and seq keeps counting after clear', () => {
    const l = mk({ capacity: 5 });
    for (let i = 0; i < 12; i++) l.info('server', `m${i}`);
    expect(l.size).toBe(5);
    expect(l.query().entries.map((e) => e.message)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(l.lastSeq).toBe(12);
    expect(l.clear()).toBe(5);
    l.info('server', 'after');
    expect(l.query().entries).toMatchObject([{ seq: 13, message: 'after' }]);
  });

  it('filters by since, level, source, session and text; limit keeps the newest', () => {
    const l = mk();
    l.info('server', 'boot');
    l.error('sdk', 'API error: authentication_failed', { code: 'authentication_failed', status: 401 }, 'sess-aaaaaaaa');
    l.warn('git', 'commit failed', { reason: 'hook rejected' }, 'sess-bbbbbbbb');
    l.debug('permission', 'asked: Bash', undefined, 'sess-aaaaaaaa');
    const msgs = (f: Parameters<Logger['entries']>[0]) => l.entries(f).entries.map((e) => e.message);
    expect(msgs({ levels: ['error', 'warn'] })).toEqual(['API error: authentication_failed', 'commit failed']);
    expect(msgs({ sources: ['git'] })).toEqual(['commit failed']);
    expect(msgs({ sessionId: 'sess-aaaaaaaa' })).toEqual(['API error: authentication_failed', 'asked: Bash']);
    expect(msgs({ q: 'HOOK' })).toEqual(['commit failed']); // case-insensitive, searches detail
    expect(msgs({ q: '401' })).toEqual(['API error: authentication_failed']);
    expect(msgs({ since: 2 })).toEqual(['commit failed', 'asked: Bash']);
    expect(msgs({ limit: 2 })).toEqual(['commit failed', 'asked: Bash']);
    expect(l.query({ levels: ['error'] }).total).toBe(1);
    expect(msgs({ levels: ['error'], sources: ['git'] })).toEqual([]);
  });

  it('parseLogFilter reads the query string (lists, unknown levels dropped, limit capped)', () => {
    const f = parseLogFilter(new URL('http://x/api/logs?since=7&level=error,warn,bogus&source=sdk,git&sessionId=abc&q=boom&limit=99999').searchParams);
    expect(f).toEqual({ since: 7, levels: ['error', 'warn'], sources: ['sdk', 'git'], sessionId: 'abc', q: 'boom', limit: 5000 });
    expect(parseLogFilter(new URL('http://x/api/logs').searchParams)).toEqual({});
  });

  it('redacts before storing: message, detail, registered secrets and token shapes', () => {
    const l = mk();
    l.setSecrets(() => ['my-gateway-password-123']);
    l.error('sdk', 'failed with my-gateway-password-123 and sk-ant-api03-ABCDEFGHIJKLMNOP', { apiKey: 'sk-live', headers: { authorization: 'Bearer abc123456' }, url: 'http://h/?token=abcdefgh1234&x=1', note: 'ok' });
    const e = l.query().entries[0]!;
    const all = JSON.stringify(e);
    expect(all).not.toContain('my-gateway-password-123');
    expect(all).not.toContain('sk-ant-api03');
    expect(all).not.toContain('sk-live');
    expect(all).not.toContain('abc123456');
    expect(all).not.toContain('abcdefgh1234');
    expect(e.detail).toMatchObject({ note: 'ok', apiKey: REDACTED });
    expect(JSON.stringify(e.detail)).toContain('x=1');
  });

  it('a session id taken from a client message cannot smuggle a secret into the entry', () => {
    const l = mk();
    l.setSecrets(() => ['my-secret-session-key-1']);
    l.warn('session', 'no live session', undefined, 'my-secret-session-key-1');
    l.warn('session', 'weird id', undefined, 'has spaces and /slashes');
    l.warn('session', 'long', undefined, 'x'.repeat(200));
    l.warn('session', 'ok', undefined, 'sess-1');
    expect(l.query().entries.map((e) => e.sessionId)).toEqual([undefined, undefined, undefined, 'sess-1']);
    expect(JSON.stringify(l.query())).not.toContain('my-secret-session-key-1');
  });

  it('text() is one redacted line per entry and carries a header', () => {
    const l = mk();
    l.setSecrets(() => ['topsecretvalue']);
    l.info('server', 'hello\nworld topsecretvalue', { a: 1 }, '12345678-aaaa');
    const t = l.text({}, '# header');
    expect(t.split('\n')[0]).toBe('# header');
    expect(t).toContain('INFO  server     [12345678] hello\\nworld [redacted] {"a":1}');
    expect(t).not.toContain('topsecretvalue');
  });

  it('subscribers get new entries; a throwing subscriber does not break logging', () => {
    const l = mk();
    const got: string[] = [];
    const off = l.subscribe((e) => got.push(e.message));
    l.subscribe(() => { throw new Error('dead socket'); });
    l.info('server', 'one'); l.info('server', 'two');
    off();
    l.info('server', 'three');
    expect(got).toEqual(['one', 'two']);
    expect(l.size).toBe(3);
  });

  it('allow() throttles a chatty key and summarises what it dropped', () => {
    let t = 1000;
    const l = mk({ now: () => t });
    const ok = Array.from({ length: 5 }, () => l.allow('k', 3, 1000));
    expect(ok).toEqual([true, true, true, false, false]);
    t += 1500;
    expect(l.allow('k', 3, 1000)).toBe(true);
    expect(l.query().entries.at(-1)!.message).toMatch(/2 more "k" entries were not logged/);
  });
});

describe('RotatingFile and file sink', () => {
  it('writes private files, rotates at the size limit and keeps 3 rotated copies', () => {
    const dir = tmp();
    const file = path.join(dir, 'logs', 'server.log');
    const f = new RotatingFile(file, 200, 3);
    for (let i = 0; i < 40; i++) f.write(`line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
    const names = fs.readdirSync(path.join(dir, 'logs')).sort();
    expect(names).toEqual(['server.log', 'server.log.1', 'server.log.2', 'server.log.3']);
    for (const n of names) expect(fs.statSync(path.join(dir, 'logs', n)).size).toBeLessThanOrEqual(200 + 60);
    // newest content is in server.log, older in .1, … ; the oldest lines are gone
    const all = names.map((n) => fs.readFileSync(path.join(dir, 'logs', n), 'utf8')).join('');
    expect(all).toContain('line 039');
    expect(all).not.toContain('line 000');
    expect(fs.readFileSync(file, 'utf8')).toContain('line 039');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, 'logs')).mode & 0o777).toBe(0o700);
    }
  });

  it('a Logger appends info+ to the file (debug stays in memory), including entries made before the file existed', () => {
    const dir = tmp();
    const l = mk();
    l.info('config', 'before the sink');
    const file = logFileFor(dir);
    expect(l.attachFile(file)).toBe(file);
    l.debug('server', 'debug only in memory');
    l.warn('server', 'warn goes to disk');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('before the sink');
    expect(text).toContain('warn goes to disk');
    expect(text).not.toContain('debug only in memory');
    expect(l.filePath).toBe(file);
    expect(l.query().file).toBe(file);
  });

  it('never writes a secret to the file', () => {
    const dir = tmp();
    const l = mk();
    l.setSecrets(() => ['file-secret-value-xyz']);
    l.attachFile(logFileFor(dir));
    l.error('cli-stderr', 'ANTHROPIC_API_KEY=file-secret-value-xyz leaked; Authorization: Bearer file-secret-value-xyz');
    const text = fs.readFileSync(logFileFor(dir), 'utf8');
    expect(text).not.toContain('file-secret-value-xyz');
    expect(text).toContain(REDACTED);
  });

  it('survives an unwritable location: logs stay in memory', () => {
    const dir = tmp();
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const l = mk();
    expect(l.attachFile(path.join(blocker, 'logs', 'server.log'))).toBeUndefined(); // a file where the directory should be
    l.info('server', 'still works');
    expect(l.query().entries.some((e) => e.message === 'still works')).toBe(true);
    expect(l.filePath).toBeUndefined();
  });

  it('logFileFor puts the log next to config.json on every OS', () => {
    expect(logFileFor('/home/u/.config/workstation', 'linux')).toBe('/home/u/.config/workstation/logs/server.log');
    expect(logFileFor('C:\\Users\\u\\AppData\\Roaming\\workstation', 'win32')).toBe('C:\\Users\\u\\AppData\\Roaming\\workstation\\logs\\server.log');
  });
});

describe('redaction', () => {
  const SECRET_TEXTS: Array<[string, string]> = [
    ['Anthropic key', 'Invalid key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv in request'],
    ['OAuth token', 'token sk-ant-oat01-AbCdEfGh12345678 expired'],
    ['OpenAI-style key', 'bad key sk-proj-AbCdEfGhIjKlMnOpQrSt1234'],
    ['Bearer header', 'Authorization: Bearer abcdef.ghijkl.mnopqr'],
    ['basic header', 'Proxy-Authorization: Basic dXNlcjpwYXNz'],
    ['x-api-key header', 'sent x-api-key: 0123456789abcdef0123'],
    ['cookie', 'Cookie: session=abc123def456; other=1'],
    ['bearer in prose', 'the server answered: Bearer abcdefghijklmnop was rejected'],
    ['auth header keeps the rest of the line', 'Authorization: Bearer abcdef.ghijkl.mnopqr and more words'],
    ['query token', 'GET http://127.0.0.1:7777/api/health?token=e2e-fixed-token-0123456789abcdef&v=1'],
    ['query api_key', 'https://gw.example.com/v1/messages?api_key=SECRETVALUE123&model=x'],
    ['url userinfo', 'proxy https://alice:hunter2pass@proxy.example.com:8080/'],
    ['env assign', 'env: ANTHROPIC_AUTH_TOKEN=tok_abcdefghij123 PATH=/usr/bin'],
    ['env assign quoted', 'GH_TOKEN="gho_abcdefghijklmnopqrstu1234"'],
    ['json field', '{"apiKey":"plainsecretvalue99","model":"x"}'],
    ['github pat', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
  ];
  for (const [name, text] of SECRET_TEXTS) {
    it(`removes: ${name}`, () => {
      const out = redactString(text);
      expect(out).toContain(REDACTED);
      for (const frag of ['sk-ant-api03', 'sk-ant-oat01', 'sk-proj-', 'abcdef.ghijkl', 'dXNlcjpwYXNz', '0123456789abcdef0123', 'abc123def456', 'abcdefghijklmnop was', 'e2e-fixed-token', 'SECRETVALUE123', 'hunter2pass', 'tok_abcdefghij123', 'gho_abcdef', 'plainsecretvalue99', 'ghp_abcdef', 'AKIAIOSFODNN7EXAMPLE', 'eyJhbGci', 'MIIEowIB']) {
        expect(out).not.toContain(frag);
      }
    });
  }

  it('keeps what is not secret (so the log stays useful)', () => {
    const keep = 'sessionId=3f2a9c1e maxTokens: 4096 status 401 authentication_failed GET /api/sessions?cwd=/home/u/proj -> 404 key not found in map';
    const out = redactString(keep.replace('key not found in map', 'nothing'));
    expect(out).toBe(keep.replace('key not found in map', 'nothing'));
    expect(redactString('?v=1&x=2&model=claude-sonnet')).toBe('?v=1&x=2&model=claude-sonnet');
    expect(redactString('https://user@host.example/x')).toBe('https://user@host.example/x');
  });

  it('removes registered exact values in plain, URL-encoded and JSON-escaped form', () => {
    const secret = 'pa/ss"word+123456';
    const text = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)].join(' | ');
    const out = redactString(text, { secrets: [secret, 'short'] });
    expect(out).not.toContain('word');
    expect(out.split(REDACTED).length - 1).toBe(3);
  });

  it('ignores very short registered values (they would mask ordinary words)', () => {
    expect(redactString('this is a short test', { secrets: ['is', 'test'] })).toBe('this is a short test');
  });

  it('is idempotent', () => {
    const once = redactString('ANTHROPIC_API_KEY=abcdef123456 Authorization: Bearer abcdefghijkl ?token=zzzzzzzz1');
    expect(redactString(once)).toBe(once);
    expect(once).not.toMatch(/\]\]/);
  });

  it('cuts very long strings', () => {
    const out = redactString('a '.repeat(5000), { maxString: 100 });
    expect(out.length).toBeLessThan(200);
    expect(out).toMatch(/more characters cut/);
  });

  it('isSecretName recognises secret-looking names and leaves ordinary ones', () => {
    for (const n of ['apiKey', 'ANTHROPIC_API_KEY', 'authToken', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'access_token', 'refreshToken', 'password', 'client_secret', 'x-api-key', 'Authorization', 'cookie', 'DB_PASSWORD', 'privateKey', 'idToken'])
      expect(isSecretName(n), n).toBe(true);
    for (const n of ['sessionId', 'maxTokens', 'inputTokens', 'model', 'cwd', 'requestId', 'author', 'SSH_AUTH_SOCK', 'toolName', 'keyboard', 'status'])
      expect(isSecretName(n), n).toBe(false);
  });

  it('redactValue: secret keys, content keys, errors, cycles, size limits', () => {
    const cyc: Record<string, unknown> = { a: 1 }; cyc.self = cyc;
    const v = redactValue({
      apiKey: 'sk-ant-api03-ABCDEFGHIJ', env: { ANTHROPIC_AUTH_TOKEN: 'abcdefghij', PATH: '/bin' }, prompt: 'my private prompt', dataBase64: 'AAAA', tokens: 12,
      err: Object.assign(new Error('boom sk-ant-api03-ABCDEFGHIJKL'), { code: 'E1', status: 401 }), cyc, list: Array.from({ length: 80 }, (_, i) => i), nested: { a: { b: { c: { d: { e: { f: 1 } } } } } },
    }) as Record<string, any>;
    const s = JSON.stringify(v);
    expect(s).not.toContain('sk-ant-api03');
    expect(s).not.toContain('abcdefghij');
    expect(s).not.toContain('my private prompt');
    expect(v.apiKey).toBe(REDACTED);
    expect(v.env.PATH).toBe('/bin');
    expect(v.env.ANTHROPIC_AUTH_TOKEN).toBe(REDACTED);
    expect(v.prompt).toMatch(/characters omitted/);
    expect(v.tokens).toBe(12);
    expect(v.err).toMatchObject({ name: 'Error', code: 'E1', status: 401 });
    expect(v.cyc.self).toBe('[circular]');
    expect(v.list).toHaveLength(51);
  });

  it('redactEnv hides secret-named values and keeps names', () => {
    expect(redactEnv({ ANTHROPIC_API_KEY: 'abc', HOME: '/home/u', GH_TOKEN: 'x', EMPTY: undefined })).toEqual({ ANTHROPIC_API_KEY: REDACTED, HOME: '/home/u', GH_TOKEN: REDACTED });
  });

  it('hostOnly drops credentials, path and query', () => {
    expect(hostOnly('https://user:pw@gw.example.com:8443/v1?key=abc')).toBe('gw.example.com:8443');
    expect(hostOnly('nonsense')).toBeUndefined();
    expect(hostOnly(undefined)).toBeUndefined();
  });
});

describe('SDK log mapping', () => {
  it('logs API errors with code, status, the provider message and request id; ignores stream events and user messages', () => {
    const l = mk();
    logSdkMessage('s1', { type: 'stream_event' }, l);
    logSdkMessage('s1', { type: 'user', message: { content: 'secret prompt' } }, l);
    logSdkMessage('s1', { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1200, error_status: 429, error: 'rate_limit' }, l);
    logSdkMessage('s1', { type: 'assistant', error: 'invalid_request', api_error_status: 400, message: { content: [{ type: 'text', text: 'messages.0: bad request (request_id: req_011CTestRequestId123)' }] } }, l);
    logSdkMessage('s1', { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['it broke: sk-ant-api03-ABCDEFGHIJKLMN'], duration_ms: 5, num_turns: 1, api_error_status: 500 }, l);
    const es = l.query().entries;
    expect(es.map((e) => [e.level, e.source, e.sessionId])).toEqual([['warn', 'sdk', 's1'], ['error', 'sdk', 's1'], ['error', 'sdk', 's1']]);
    expect(es[0]!.message).toContain('429');
    expect(es[0]!.detail).toMatchObject({ code: 'rate_limit', status: 429, attempt: 2, maxRetries: 10 });
    expect(es[1]!.detail).toMatchObject({ code: 'invalid_request', status: 400, requestId: 'req_011CTestRequestId123' });
    expect(es[1]!.detail!.providerMessage).toContain('bad request');
    expect(es[2]!.detail).toMatchObject({ subtype: 'error_during_execution', status: 500 });
    expect(JSON.stringify(es)).not.toContain('secret prompt');
    expect(JSON.stringify(es)).not.toContain('sk-ant-api03');
  });

  it('successful turns are debug, not noise', () => {
    const l = mk();
    logSdkMessage('s1', { type: 'result', subtype: 'success', is_error: false, duration_ms: 12, num_turns: 2, total_cost_usd: 0.01 }, l);
    expect(l.query().entries).toMatchObject([{ level: 'debug', message: 'Turn finished' }]);
  });

  it('requestIdIn finds Anthropic request ids', () => {
    expect(requestIdIn('Internal server error (request_id: req_011CABCdef12345678)')).toBe('req_011CABCdef12345678');
    expect(requestIdIn('nothing here')).toBeUndefined();
  });

  it('MCP: logs first sight and changes only, with levels by status', () => {
    const l = mk();
    logMcpStatus('m1', [{ name: 'files', status: 'pending' }, { name: 'web', status: 'connected' }], l);
    logMcpStatus('m1', [{ name: 'files', status: 'pending' }, { name: 'web', status: 'connected' }], l);
    logMcpStatus('m1', [{ name: 'files', status: 'failed', error: 'spawn ENOENT' }], l);
    expect(l.query().entries.map((e) => [e.level, e.source, e.message])).toEqual([
      ['debug', 'mcp', 'MCP server "files": pending'], ['info', 'mcp', 'MCP server "web": connected'], ['error', 'mcp', 'MCP server "files": failed'],
    ]);
    expect(l.query().entries[2]!.detail).toMatchObject({ error: 'spawn ENOENT' });
  });

  it('CLI stderr: whole lines, levels by content, partial lines are joined, secrets removed', async () => {
    const l = mk();
    const err = createStderrLogger('s2', l);
    err('starting up\nFatal: cannot open /x\nsome error occ');
    err('urred ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOP\n');
    err('trailing without newline');
    await new Promise((r) => setTimeout(r, 600));
    const es = l.query().entries;
    expect(es.map((e) => [e.level, e.source, e.sessionId])).toEqual([['info', 'cli-stderr', 's2'], ['error', 'cli-stderr', 's2'], ['warn', 'cli-stderr', 's2'], ['info', 'cli-stderr', 's2']]);
    expect(es[2]!.message).toBe(`some error occurred ANTHROPIC_API_KEY=${REDACTED}`);
    expect(es[3]!.message).toBe('trailing without newline');
  });

  it('CLI stderr: a flood is rate limited with a summary', () => {
    let t = 0;
    const l = mk({ now: () => t, capacity: 1000 });
    const err = createStderrLogger('s3', l, () => t);
    for (let i = 0; i < 400; i++) err(`line ${i}\n`);
    expect(l.size).toBe(300);
    t = 61_000;
    err('next window\n');
    expect(l.query().entries.some((e) => /100 more stderr lines not logged/.test(e.message))).toBe(true);
  });
});

describe('debug info', () => {
  it('has versions, only the base URL host, the session and its last 50 redacted lines', () => {
    const l = mk();
    l.setSecrets(() => ['secret-key-material-1']);
    for (let i = 0; i < 60; i++) l.info('session', `line ${i} secret-key-material-1`, undefined, 'sess-1');
    l.info('session', 'other session', undefined, 'sess-2');
    const t = debugInfoText({ appVersion: '9.9.9', mock: false, baseUrl: 'https://user:pw@gw.example.com:8443/v1?key=abc', sessionId: 'sess-1', live: true, model: 'claude-x', permissionMode: 'plan', logger: l, secrets: () => ['secret-key-material-1'] });
    expect(t).toContain('App version:     9.9.9');
    expect(t).toContain(`Node:            ${process.version}`);
    expect(t).toMatch(/Agent SDK:\s+\d+\.\d+\.\d+/);
    expect(t).toContain('Base URL host:   gw.example.com:8443');
    expect(t).toContain('Model:           claude-x');
    expect(t).toContain('Permission mode: plan');
    expect(t).toContain('Last 50 log lines');
    expect(t).toContain('line 59');
    expect(t).not.toContain('line 9 ');
    expect(t).not.toContain('other session');
    for (const bad of ['user:pw', '/v1', 'key=abc', 'secret-key-material-1']) expect(t).not.toContain(bad);
  });
  it('says so when the base URL is the default', () => {
    expect(debugInfoText({ appVersion: '1', mock: true, logger: mk() })).toContain('api.anthropic.com (default)');
  });
});

describe('formatEntry', () => {
  it('is a single line', () => {
    const line = formatEntry({ seq: 1, ts: Date.UTC(2026, 0, 2, 3, 4, 5, 6), level: 'warn', source: 'git', message: 'a\nb', detail: { n: 1 } });
    expect(line).toBe('2026-01-02T03:04:05.006Z WARN  git        a\\nb {"n":1}');
  });
});

describe('redaction details', () => {
  it('does not eat the rest of the line after an Authorization value', () => {
    expect(redactString('Authorization: Bearer abcdef.ghijkl.mnopqr and more words')).toBe('Authorization: [redacted] and more words');
  });
  it('redacts a token that was already replaced as an exact value without leaving a stray bracket', () => {
    expect(redactString('http://x/?token=abcdefghijkl&a=1', { secrets: ['abcdefghijkl'] })).toBe('http://x/?token=[redacted]&a=1');
  });
});
