import http from 'node:http';
import { makeRig, isResult } from './real-harness.js';
const reqs: any[] = [];
const mode = process.argv[2] ?? '401';
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => {
    reqs.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], auth: req.headers.authorization, ua: req.headers['user-agent'] });
    if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
    else { res.writeHead(529, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })); }
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const port = (srv.address() as any).port;
const r = makeRig({ config: { anthropicBaseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-fake-123' } });
const sid = await r.start();
await r.send({ type: 'prompt', sessionId: sid, text: 'hi', clientMsgId: 'a' });
await r.sub.waitFor(isResult, 45000).catch(() => console.log("NO RESULT"));
console.log('REQS', JSON.stringify(reqs.slice(0, 3)));
for (const m of r.sub.msgs) {
  if (m.type === 'sdk') { const x: any = m.message; if (x.type !== 'stream_event') console.log('SDK', JSON.stringify(x).slice(0, 500)); }
  else if (m.type === 'error' || m.type === 'session.ended') console.log(m.type, JSON.stringify(m));
}
r.cleanup(); srv.close(); process.exit(0);
