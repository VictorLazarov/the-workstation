import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeRig, isResult } from './real-harness.js';
const r = makeRig();
fs.mkdirSync(path.join(r.cwd, '.claude'), { recursive: true });
fs.writeFileSync(path.join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { mini: { command: 'node', args: [path.resolve('scripts/mini-mcp.mjs')] } } }));
fs.writeFileSync(path.join(r.cwd, '.claude/settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
const sid = await r.start();
const log = (...a: any[]) => console.log(...a);
const errs = () => r.sub.msgs.filter((m) => m.type === 'error').map((m: any) => m.message);
// MCP
await new Promise((x) => setTimeout(x, 3000));
const q: any = r.mgr.get(sid)!.query;
log('status0', JSON.stringify((await q.mcpServerStatus()).map((s: any) => [s.name, s.status])));
let mark = r.sub.mark();
await r.send({ type: 'mcp.toggle', sessionId: sid, server: 'mini', enabled: false });
log('toggle off', JSON.stringify(r.sub.msgs.slice(mark).filter((m) => m.type === 'ack').map((m: any) => m.data.mcpServers.map((s: any) => [s.name, s.status]))), errs());
await r.send({ type: 'mcp.toggle', sessionId: sid, server: 'mini', enabled: true });
log('toggle on', JSON.stringify(r.sub.msgs.slice(mark).filter((m) => m.type === 'ack').at(-1)?.data.mcpServers.map((s: any) => [s.name, s.status])), errs());
await r.send({ type: 'mcp.reconnect', sessionId: sid, server: 'mini' });
log('reconnect', JSON.stringify(r.sub.msgs.filter((m) => m.type === 'ack').at(-1)?.data.mcpServers.map((s: any) => [s.name, s.status])), errs());
// image: 8x8 red PNG
function png() {
  const crc = (b: Buffer) => { let c, t: number[] = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255]! ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const ch = (type: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 8 }, () => [255, 0, 0]).flat())])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ihdr), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
}
mark = r.sub.mark();
await r.send({ type: 'prompt', sessionId: sid, text: 'What single color is this image? One word.', images: [{ mediaType: 'image/png', dataBase64: png().toString('base64'), name: 'red.png' }], clientMsgId: 'img' });
const res: any = await r.sub.waitFor(isResult, 60000, mark);
log('image', res.message.subtype, res.message.result, errs());
// mcp tool call
mark = r.sub.mark();
await r.send({ type: 'prompt', sessionId: sid, text: 'Call the mcp ping tool from server mini and tell me its output.', clientMsgId: 'm' });
const n: any = await r.sub.waitFor((m) => isResult(m) || m.type === 'permission.request', 60000, mark);
log('mcp tool:', n.type, n.toolName, n.message?.result);
if (n.type === 'permission.request') { await r.send({ type: 'permission.respond', sessionId: sid, requestId: n.requestId, decision: { behavior: 'allow' } }); const x: any = await r.sub.waitFor(isResult, 60000, mark); log('after', x.message.result); }
r.cleanup(); process.exit(0);
