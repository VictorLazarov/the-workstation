import type { ClientMessage, ServerMessage } from '@workstation/protocol';
import type { ConnStatus, Transport } from './types';

export class WsTransport implements Transport {
  status: ConnStatus = 'closed';
  private ws: WebSocket | null = null;
  private msgCbs = new Set<(m: ServerMessage) => void>();
  private statusCbs = new Set<(s: ConnStatus) => void>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private token: string | null) {}

  private set(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusCbs.forEach((cb) => cb(s));
  }

  connect() {
    this.stopped = false;
    clearTimeout(this.timer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.set('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set('open');
      clearInterval(this.ping);
      this.ping = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
    ws.onmessage = (ev) => {
      let m: ServerMessage;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      this.msgCbs.forEach((cb) => cb(m));
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      this.ws = null;
      this.set('closed');
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  private scheduleReconnect() {
    this.set('closed');
    const delay = Math.min(5000, 400 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.ws?.close();
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }
  onMessage(cb: (m: ServerMessage) => void) { this.msgCbs.add(cb); return () => this.msgCbs.delete(cb); }
  onStatus(cb: (s: ConnStatus) => void) { this.statusCbs.add(cb); return () => this.statusCbs.delete(cb); }
}
