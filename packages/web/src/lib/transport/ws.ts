import type { ClientMessage, ServerMessage } from '@workstation/protocol';
import type { ConnStatus, Transport } from './types';
import { getServerBase } from '../storage';

export const MAX_RETRIES = 10;
/** Delay before automatic retry number `n` (0-based): 0.5s, 1s, 2s … capped at 30s. */
export const reconnectDelay = (n: number): number => Math.min(30_000, 500 * 2 ** n);

export class WsTransport implements Transport {
  status: ConnStatus = 'closed';
  private ws: WebSocket | null = null;
  private msgCbs = new Set<(m: ServerMessage) => void>();
  private statusCbs = new Set<(s: ConnStatus) => void>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private token: string | null) {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { if (this.status === 'offline') this.connect(); });
      // Safari/Firefox close sockets when a page enters the back/forward cache (and Safari suspends background tabs):
      // on return, reconnect right away instead of waiting out a backoff timer that may never have fired.
      window.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) this.revive(); });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.revive(); });
    }
  }

  /** Reconnect now if the socket died while the page was hidden / cached (no-op when open, connecting or closed on purpose). */
  private revive() {
    if (this.stopped) return;
    const rs = this.ws?.readyState;
    if (this.ws && (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING)) return;
    this.connect();
  }

  private set(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusCbs.forEach((cb) => cb(s));
  }

  /** Manual (re)connect: gives automatic retries a fresh budget. */
  connect() {
    this.retry = 0;
    this.open();
  }

  private open() {
    this.stopped = false;
    clearTimeout(this.timer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.set('connecting');
    const base = new URL(getServerBase());
    const proto = base.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${base.host}/ws${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
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
      if (!this.stopped) this.scheduleReconnect(); else this.set('closed');
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  /**
   * Backoff 0.5s, 1s, 2s … capped at 30s, for at most MAX_RETRIES attempts (about 2 minutes), then `offline`: no
   * endless retrying against a server that is down or rejecting us. Coming back online (or Retry) starts over.
   */
  private scheduleReconnect() {
    if (this.retry >= MAX_RETRIES) { this.set('offline'); return; }
    this.set('closed');
    const delay = reconnectDelay(this.retry++);
    this.timer = setTimeout(() => this.open(), delay);
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
