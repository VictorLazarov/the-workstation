import { makeRig, isResult } from './real-harness.js';
const which = process.argv[2];
const log = (...a: any[]) => console.log(...a);
const brief = (r: any) => r.sub.msgs.filter((m: any) => m.type !== 'sdk' || ['result','assistant','system'].includes(m.message.type) && m.message.subtype !== 'status' && m.message.subtype !== 'thinking_tokens').map((m: any) => m.type === 'sdk' ? 'sdk:' + JSON.stringify(m.message).slice(0, 300) : JSON.stringify(m).slice(0, 300));
if (which === 'noresume') {
  const r = makeRig();
  try { const sid = await r.start({ resume: '11111111-2222-3333-4444-555555555555' }); log('started', sid); await r.send({ type: 'prompt', sessionId: sid, text: 'hi', clientMsgId: 'a' }); await r.sub.waitFor(isResult, 30000).catch(() => log('noresult')); } catch (e) { log('start threw', String(e)); }
  log(brief(r).join('\n'));
} else if (which === 'badmodel') {
  const r = makeRig();
  const sid = await r.start({ model: 'claude-nope-9' });
  await r.send({ type: 'prompt', sessionId: sid, text: 'hi', clientMsgId: 'a' });
  await r.sub.waitFor(isResult, 60000).catch(() => log('noresult'));
  log(brief(r).join('\n'));
} else if (which === 'crash') {
  const r = makeRig();
  const sid = await r.start();
  await r.send({ type: 'prompt', sessionId: sid, text: 'Write a 400 word story about a cat.', clientMsgId: 'a' });
  await r.sub.waitFor((m) => m.type === 'sdk' && (m.message as any).type === 'stream_event', 60000);
  const { execSync } = await import('node:child_process');
  const out = execSync(`pgrep -f "claude.*--input-format" || true`).toString().trim().split('\n');
  log('pids', out);
  for (const p of out) if (p) try { process.kill(Number(p), 'SIGKILL'); } catch {}
  await new Promise((x) => setTimeout(x, 3000));
  log('live?', r.mgr.isLive(sid));
  log(r.sub.msgs.filter((m) => m.type !== 'sdk' ).map((m) => JSON.stringify(m).slice(0, 300)).join('\n'));
} else if (which === 'rapid') {
  const r = makeRig();
  const sid = await r.start();
  for (const w of ['one', 'two', 'three']) await r.send({ type: 'prompt', sessionId: sid, text: `Reply with exactly: ${w}`, clientMsgId: w });
  const t0 = Date.now();
  await r.sub.waitFor(() => r.sub.sdk().filter((m) => m.type === 'result').length >= 3, 120000).catch(() => {});
  log('results', r.sub.sdk().filter((m) => m.type === 'result').map((m) => m.result), 'status', r.mgr.runtimeState(r.mgr.get(sid)!).status, 'inflight', r.mgr.get(sid)!.inflight.size);
  log(r.sub.msgs.filter((m)=>m.type==='state').map((m:any)=>m.state.status).join(','));
} else if (which === 'huge') {
  const r = makeRig();
  const sid = await r.start({ permissionMode: 'bypassPermissions' });
  await r.send({ type: 'prompt', sessionId: sid, text: 'Run bash: `head -c 3000000 /dev/zero | tr "\\0" "x"` and then say done. ', clientMsgId: 'a' });
  await r.sub.waitFor(isResult, 120000).catch(() => log('noresult'));
  const sizes = r.sub.sdk().map((m) => JSON.stringify(m).length).sort((a, b) => b - a).slice(0, 3);
  log('biggest', sizes);
}
process.exit(0);
