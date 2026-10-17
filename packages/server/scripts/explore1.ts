import { makeRig, isResult } from './real-harness.js';
const r = makeRig();
const sid = await r.start();
console.log('started', sid, JSON.stringify((r.mgr.get(sid)!.init as any)).slice(0, 300));
await r.send({ type: 'prompt', sessionId: sid, text: 'Reply with exactly: pong', clientMsgId: 'c1' });
await r.sub.waitFor(isResult);
console.log(JSON.stringify(r.sub.sdk().at(-1)).slice(0, 600));
r.cleanup();
process.exit(0);
