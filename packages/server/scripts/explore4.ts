import { makeRig, isResult } from './real-harness.js';
const r = makeRig();
const sid = await r.start();
const s: any = r.mgr.get(sid);
// capture suggestions via pending map
const origRespond = r.mgr.respond.bind(r.mgr);
(r.mgr as any).respond = (ss: any, id: string, d: any) => { console.log('SUGGESTIONS', JSON.stringify(ss.pending.get(id)?.suggestions)); return origRespond(ss, id, d); };
await r.send({ type: 'prompt', sessionId: sid, text: 'Run the bash command `touch f1.txt` using Bash tool. Nothing else.', clientMsgId: 'c1' });
const req: any = await r.sub.waitFor((m) => m.type === 'permission.request');
console.log('REQ', JSON.stringify(req).slice(0, 500));
await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: true } });
await r.sub.waitFor(isResult);
const mark = r.sub.mark();
await r.send({ type: 'prompt', sessionId: sid, text: 'Run the bash command `touch f1.txt` again using Bash tool. Nothing else.', clientMsgId: 'c2' });
const n: any = await r.sub.waitFor((m) => isResult(m) || m.type === 'permission.request', 90000, mark);
console.log('2nd:', n.type);
import fs from 'node:fs';
for (const f of [r.cwd + '/.claude/settings.local.json']) console.log(f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 'none');
r.cleanup(); process.exit(0);
