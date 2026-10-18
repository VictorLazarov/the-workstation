import http from 'node:http';
import net from 'node:net';

/**
 * A tiny fake Anthropic-compatible gateway (LiteLLM / OpenRouter style) for tests: serves GET /v1/models, answers POST /v1/messages
 * for the models it serves and rejects every other model with the real API's error shape
 * `404 {"type":"error","error":{"type":"not_found_error","message":"model: X"}}`. Wrong credentials give the 401 shape.
 * It records every request (headers included) so tests can assert what a client sent.
 */
export interface FakeGatewayOptions {
  /** model ids it serves (default: gw-fast, gw-smart) */
  models?: string[];
  /** accepted credential: `x-api-key: <key>` or `Authorization: Bearer <key>` (default: any request is accepted) */
  key?: string;
  /** list models as OpenAI does ({object:'list',data:[{id,object:'model'}]}) instead of Anthropic's ({data:[{type:'model',id,display_name}]}) */
  openaiShape?: boolean;
  /** GET /v1/models answers 404 (a gateway that does not list models) */
  noList?: boolean;
  /** redirect every request to this absolute URL */
  redirectTo?: string;
}
export interface GatewayRequest { method: string; path: string; headers: http.IncomingHttpHeaders; body: unknown }
export interface FakeGateway {
  url: string;
  models: string[];
  requests: GatewayRequest[];
  /** requests that carried a model, in order */
  modelsAsked: () => string[];
  stop: () => Promise<void>;
}

export async function startFakeGateway(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const models = [...(opts.models ?? ['gw-fast', 'gw-smart'])];
  const requests: GatewayRequest[] = [];
  const err = (res: http.ServerResponse, status: number, type: string, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: unknown;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; } catch { body = undefined; }
      const path = (req.url ?? '').split('?')[0]!;
      requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });
      if (opts.redirectTo) { res.writeHead(302, { location: opts.redirectTo }); res.end(); return; }
      if (opts.key) {
        const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
        if (req.headers['x-api-key'] !== opts.key && bearer !== opts.key) return err(res, 401, 'authentication_error', 'invalid x-api-key');
      }
      if (req.method === 'GET' && path === '/v1/models') {
        if (opts.noList) return err(res, 404, 'not_found_error', 'Not Found');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(opts.openaiShape
          ? { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })) }
          : { data: models.map((id) => ({ type: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z' })), has_more: false, first_id: models[0] ?? null, last_id: models[models.length - 1] ?? null }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const model = (body as { model?: unknown } | undefined)?.model;
        if (typeof model !== 'string' || !models.includes(model)) return err(res, 404, 'not_found_error', `model: ${String(model)}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
        return;
      }
      err(res, 404, 'not_found_error', 'Not Found');
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  return {
    url: `http://127.0.0.1:${port}`,
    models,
    requests,
    modelsAsked: () => requests.map((r) => (r.body as { model?: string } | undefined)?.model).filter((m): m is string => typeof m === 'string'),
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
