import { makeRig, isResult } from './real-harness.js';
const variant = process.argv[2] ?? 'approve';
const r = makeRig();
const sid = await r.start({ permissionMode: 'plan' });
// spy on raw permission result
const mgr: any = r.mgr;
await r.send({ type: 'prompt', sessionId: sid, text: 'We are in plan mode. Plan: create file hello.txt containing "hi". Call ExitPlanMode with a 2-line plan immediately, no exploration. After approval, create the file.', clientMsgId: 'c1' });
const req: any = await r.sub.waitFor((m) => m.type === 'permission.request');
console.log('REQ', req.toolName, JSON.stringify(req).slice(0, 700));
const dec = variant === 'approve' ? { behavior: 'allow' } : variant === 'edits' ? { behavior: 'allow', setMode: 'acceptEdits' } : { behavior: 'deny', message: 'Also add a second file bye.txt to the plan' };
await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: dec as any });
// wait for either result or another permission request
const next = await r.sub.waitFor((m) => isResult(m) || (m.type === 'permission.request' && (m as any).requestId !== req.requestId), 90_000, 0);
console.log('NEXT', next.type, next.type === 'permission.request' ? JSON.stringify(next).slice(0, 500) : '');
console.log('mode', r.mgr.get(sid)?.permissionMode);
for (const m of r.sub.sdk()) {
  if (m.type === 'user' && Array.isArray(m.message?.content)) console.log('USER', JSON.stringify(m.message.content).slice(0, 400));
  if (m.type === 'assistant') console.log('ASSIST', JSON.stringify(m.message.content).slice(0, 200));
  if (m.type === 'system') console.log('SYS', m.subtype, m.permissionMode ?? '');
}
console.log(r.sub.msgs.filter(m=>m.type==='state').map((m:any)=>m.state.permissionMode+':'+m.state.status).join(' '));
r.cleanup(); process.exit(0);
