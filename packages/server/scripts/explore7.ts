import { makeRig, isResult } from './real-harness.js';
import { createRealAdapter } from '../src/sdk.js';
import { SessionManager } from '../src/session-manager.js';
import { Collector } from './real-harness.js';
const log = (...a: any[]) => console.log(...a);
const r = makeRig();
const sid = await r.start();
await r.send({ type: 'prompt', sessionId: sid, text: 'Remember the secret word: banana. Reply "noted".', clientMsgId: 'a' });
await r.sub.waitFor(isResult);
r.mgr.closeAll();
log('ended evt', r.sub.msgs.filter((m) => m.type === 'session.ended').length);
const ad = createRealAdapter();
log('list', JSON.stringify((await ad.listSessions({ dir: r.cwd })).map((s) => [s.sessionId === sid, s.summary, s.firstPrompt])));
log('msgs', (await ad.getSessionMessages(sid, { dir: r.cwd })).length);
// "restart"
const mgr2 = new SessionManager(ad, r.config, r.cwd);
const sub2 = new Collector();
await mgr2.handle(sub2, { type: 'session.start', reqId: 'r1', cwd: r.cwd, resume: sid, model: 'claude-haiku-5-5' });
const st: any = await sub2.waitFor((m) => (m.type === 'session.started' || m.type === 'error'));
log('resumed', st.type, st.sessionId === sid, st.message);
await mgr2.handle(sub2, { type: 'prompt', sessionId: sid, text: 'What was the secret word? One word.', clientMsgId: 'b' });
const res: any = await sub2.waitFor(isResult);
log('resume answer', res.message.result, res.message.session_id === sid);
// fork
await mgr2.handle(sub2, { type: 'session.start', reqId: 'f1', cwd: r.cwd, resume: sid, fork: true, model: 'claude-haiku-5-5' });
const fk: any = await sub2.waitFor((m) => (m.type === 'session.started' && (m as any).reqId === 'f1') || (m.type === 'error' && (m as any).reqId === 'f1'));
log('fork', fk.type, fk.sessionId, fk.sessionId !== sid, fk.message);
if (fk.sessionId) {
  const mark = sub2.mark();
  await mgr2.handle(sub2, { type: 'prompt', sessionId: fk.sessionId, text: 'What was the secret word? One word.', clientMsgId: 'c' });
  const r2: any = await sub2.waitFor((m) => isResult(m) && (m as any).sessionId === fk.sessionId, 90000, mark);
  log('fork answer', r2.message.result, r2.message.session_id === fk.sessionId);
  log('list2', JSON.stringify((await ad.listSessions({ dir: r.cwd })).map((s) => s.sessionId)));
}
mgr2.closeAll(); process.exit(0);
