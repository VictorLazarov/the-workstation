/** Captures real-SDK interrupt / 401 / permission-interrupt message streams into test/fixtures (REAL_SDK, tiny haiku calls). */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isResult, makeRig } from './real-harness.js';

const out = path.resolve(import.meta.dirname, '../test/fixtures');
fs.mkdirSync(out, { recursive: true });
const ask = (r: any, sid: string, text: string) => r.send({ type: 'prompt', sessionId: sid, text, clientMsgId: 'c1' });
const slim = (msgs: any[]) => msgs.filter((m) => !(m.type === 'sdk' && m.message?.type === 'stream_event' && m.message.event?.type === 'content_block_delta' && Math.random() < 0.0));

// 1. interrupt mid-stream
{
  const r = makeRig();
  const sid = await r.start();
  const mark = r.sub.mark();
  await ask(r, sid, 'Write a very long essay about lighthouses, at least 2000 words.');
  await r.sub.waitFor((m: any) => m.type === 'sdk' && m.message.type === 'stream_event' && m.message.event?.type === 'content_block_delta', 60000, mark);
  await new Promise((x) => setTimeout(x, 1500));
  await r.send({ type: 'interrupt', sessionId: sid });
  await r.sub.waitFor(isResult, 30000, mark);
  await new Promise((x) => setTimeout(x, 800));
  fs.writeFileSync(path.join(out, 'real-interrupt-stream.json'), JSON.stringify(r.sub.msgs.slice(mark), null, 1));
  // 2. interrupt while a permission is pending
  const mark2 = r.sub.mark();
  await ask(r, sid, 'Run the bash command `touch b.txt` with the Bash tool. Nothing else.');
  await r.sub.waitFor((m: any) => m.type === 'permission.request', 60000, mark2);
  await r.send({ type: 'interrupt', sessionId: sid });
  await r.sub.waitFor(isResult, 30000, mark2);
  await new Promise((x) => setTimeout(x, 800));
  fs.writeFileSync(path.join(out, 'real-interrupt-permission.json'), JSON.stringify(r.sub.msgs.slice(mark2), null, 1));
  r.cleanup();
}
// 3. 401 from a bad base URL
{
  const srv = http.createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); });
  await new Promise<void>((x) => srv.listen(0, '127.0.0.1', x));
  const r = makeRig({ config: { anthropicBaseUrl: `http://127.0.0.1:${(srv.address() as any).port}`, apiKey: 'sk-fake-123' } });
  const sid = await r.start();
  const mark = r.sub.mark();
  await ask(r, sid, 'say hi');
  await r.sub.waitFor(isResult, 60000, mark);
  await new Promise((x) => setTimeout(x, 800));
  fs.writeFileSync(path.join(out, 'real-401.json'), JSON.stringify(r.sub.msgs.slice(mark), null, 1));
  r.cleanup(); srv.close();
}
process.exit(0);
