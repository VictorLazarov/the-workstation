import { makeRig, isResult } from './real-harness.js';
const r = makeRig();
const sid = await r.start();
for (const w of ['one', 'two', 'three']) await r.send({ type: 'prompt', sessionId: sid, text: `Reply with exactly: ${w}`, clientMsgId: w });
await new Promise((x) => setTimeout(x, 25000));
for (const m of r.sub.sdk()) {
  if (m.type === 'command_lifecycle') console.log('LC', m.state, m.command_uuid?.slice(0, 6));
  else if (m.type === 'user') console.log('USER', m.uuid?.slice(0, 6), JSON.stringify(m.message.content).slice(0, 60), m.origin);
  else if (m.type === 'result') console.log('RESULT', m.result, JSON.stringify(m).match(/"uuid":"[^"]+"/g));
  else if (m.type === 'system' && m.subtype === 'status') console.log('STATUS', m.status, m.user_message_uuids?.map((x: string) => x.slice(0, 6)));
}
process.exit(0);
