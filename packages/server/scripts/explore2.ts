import { makeRig, isResult } from './real-harness.js';
const r = makeRig();
const sid = await r.start();
await r.send({ type: 'prompt', sessionId: sid, text: 'Use the AskUserQuestion tool right now to ask me one question "Which color?" header "Color" with options Red and Blue (multiSelect false). Then reply with only the color I chose.', clientMsgId: 'c1' });
const req: any = await r.sub.waitFor((m) => m.type === 'permission.request');
console.log('REQ', req.toolName, JSON.stringify(req.input));
const q = req.input.questions[0];
await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', updatedInput: { ...req.input, answers: { [q.question]: 'Blue' } } } });
await r.sub.waitFor(isResult);
for (const m of r.sub.sdk()) {
  if (m.type === 'user' && Array.isArray(m.message?.content)) console.log('USER', JSON.stringify(m.message.content).slice(0, 500));
  if (m.type === 'assistant') console.log('ASSIST', JSON.stringify(m.message.content).slice(0, 300));
}
r.cleanup(); process.exit(0);
