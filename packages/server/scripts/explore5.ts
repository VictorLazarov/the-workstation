import { makeRig, isResult } from './real-harness.js';
const r = makeRig();
const sid = await r.start();
const log = (...a: any[]) => console.log(...a);
const errs = () => r.sub.msgs.filter((m) => m.type === 'error').map((m: any) => m.message);
// A: interrupt mid-turn
let mark = r.sub.mark();
await r.send({ type: 'prompt', sessionId: sid, text: 'Write a 600 word story about a cat.', clientMsgId: 'a' });
await r.sub.waitFor((m) => m.type === 'sdk' && (m.message as any).type === 'stream_event', 60000, mark);
await r.send({ type: 'interrupt', sessionId: sid });
let res: any = await r.sub.waitFor(isResult, 30000, mark);
log('A interrupt result', (res.message as any).subtype, (res.message as any).is_error, 'status', r.mgr.runtimeState(r.mgr.get(sid)!).status, errs());
// B: interrupt mid-permission
mark = r.sub.mark();
await r.send({ type: 'prompt', sessionId: sid, text: 'Run the bash command `touch b.txt` using Bash tool. Nothing else.', clientMsgId: 'b' });
const req: any = await r.sub.waitFor((m) => m.type === 'permission.request', 60000, mark);
await r.send({ type: 'interrupt', sessionId: sid });
res = await r.sub.waitFor(isResult, 30000, mark);
log('B interrupt-permission result', (res.message as any).subtype, 'cancelled evt', r.sub.msgs.slice(mark).some((m) => m.type === 'permission.cancelled'), 'status', r.mgr.runtimeState(r.mgr.get(sid)!).status, errs());
// C: after interrupt, session still works
mark = r.sub.mark();
await r.send({ type: 'prompt', sessionId: sid, text: 'Reply with exactly: ok', clientMsgId: 'c' });
res = await r.sub.waitFor(isResult, 60000, mark);
log('C after', (res.message as any).subtype, (res.message as any).result);
// D: set.model / mode / effort
await r.send({ type: 'set.model', sessionId: sid, model: 'claude-sonnet-5-5' });
await r.send({ type: 'set.permissionMode', sessionId: sid, mode: 'bypassPermissions' });
await r.send({ type: 'set.effort', sessionId: sid, effort: 'low' });
log('D state', JSON.stringify(r.mgr.runtimeState(r.mgr.get(sid)!)), errs());
mark = r.sub.mark();
await r.send({ type: 'prompt', sessionId: sid, text: 'Run the bash command `touch d.txt` using Bash tool. Then reply done.', clientMsgId: 'd' });
const n: any = await r.sub.waitFor((m) => isResult(m) || m.type === 'permission.request', 90000, mark);
log('D bypass => ', n.type, 'model used:', JSON.stringify(Object.keys((n.message?.modelUsage) ?? {})));
const st = r.sub.sdk().filter((m) => m.type === 'system' && m.subtype === 'status');
log('status msgs', JSON.stringify(st.map((m) => m.permissionMode)));
r.cleanup(); process.exit(0);
