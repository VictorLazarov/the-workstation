import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { getServerBase, getToken } from '../../lib/storage';
import { onThemeChange, readTermTheme } from './xtermTheme';

export interface TermHandle { clear(): void; copy(): Promise<boolean>; focus(): void }
type Status = { kind: 'connecting' } | { kind: 'live'; backend: string } | { kind: 'exited'; code: number | null } | { kind: 'unavailable'; message: string } | { kind: 'disconnected' };

function wsUrl(id: string, cwd: string, cols: number, rows: number): string {
  const base = getServerBase().replace(/^http/, 'ws');
  const q = new URLSearchParams({ id, cwd, cols: String(cols), rows: String(rows) });
  const t = getToken();
  if (t) q.set('token', t);
  return `${base}/ws/terminal?${q}`;
}

export const TermView = forwardRef<TermHandle, { id: string; cwd: string; visible: boolean }>(function TermView({ id, cwd, visible }, ref) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ term?: import('@xterm/xterm').Terminal; fit?: () => void; reconnect?: () => void }>({});
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });

  useImperativeHandle(ref, () => ({
    clear: () => api.current.term?.clear(),
    copy: async () => {
      const sel = api.current.term?.getSelection() || '';
      if (!sel) return false;
      try { await navigator.clipboard.writeText(sel); return true; } catch { return false; }
    },
    focus: () => api.current.term?.focus(),
  }));

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let cleanup = () => {};
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]);
      if (disposed || !host.current) return;
      const term = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: true, theme: readTermTheme() });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      const doFit = () => { try { if (host.current && host.current.clientWidth > 0) fit.fit(); } catch { /* not laid out */ } };
      doFit();
      api.current = { term, fit: doFit };
      if (visibleRef.current) term.focus();
      const offTheme = onThemeChange(() => { term.options.theme = readTermTheme(); });

      let dead = false; // unavailable: don't reconnect
      let retry: ReturnType<typeof setTimeout> | undefined;
      const send = (m: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
      const connect = () => {
        if (disposed) return;
        setStatus({ kind: 'connecting' });
        const sock = new WebSocket(wsUrl(id, cwd, term.cols, term.rows));
        ws = sock;
        let ready = false;
        sock.onmessage = (ev) => {
          let m: { type: string; data?: string; code?: number | null; message?: string; backend?: string };
          try { m = JSON.parse(String(ev.data)); } catch { return; }
          if (m.type === 'ready') { ready = true; term.reset(); setStatus({ kind: 'live', backend: m.backend ?? '' }); send({ type: 'resize', cols: term.cols, rows: term.rows }); }
          else if ((m.type === 'replay' || m.type === 'data') && m.data) term.write(m.data);
          else if (m.type === 'exit') { setStatus({ kind: 'exited', code: m.code ?? null }); dead = true; }
          else if (m.type === 'unavailable') { dead = true; setStatus({ kind: 'unavailable', message: m.message ?? 'Terminal unavailable' }); }
          else if (m.type === 'error') { dead = true; setStatus({ kind: 'unavailable', message: m.message ?? 'Terminal error' }); }
        };
        sock.onclose = () => {
          if (disposed || ws !== sock) return;
          if (dead) return;
          setStatus({ kind: 'disconnected' });
          retry = setTimeout(connect, ready ? 1000 : 3000);
        };
      };
      api.current.reconnect = () => { dead = false; ws?.close(); connect(); };
      term.onData((d) => send({ type: 'input', data: d }));
      term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
      const ro = new ResizeObserver(doFit);
      ro.observe(host.current);
      connect();
      cleanup = () => { clearTimeout(retry); ro.disconnect(); offTheme(); const s = ws; ws = null; s?.close(); term.dispose(); };
      if (disposed) cleanup();
    })();
    return () => { disposed = true; cleanup(); api.current = {}; };
  }, [id, cwd]);

  useEffect(() => { if (visible) { requestAnimationFrame(() => { api.current.fit?.(); api.current.term?.focus(); }); } }, [visible]);

  return (
    <div className="term-wrap" style={{ display: visible ? undefined : 'none' }}>
      <div className="term-host" ref={host} data-testid="term-host" />
      {status.kind === 'unavailable' && <div className="term-overlay term-err" role="alert"><b>Terminal unavailable</b><span>{status.message}</span></div>}
      {status.kind === 'exited' && <div className="term-banner">Shell exited{status.code !== null ? ` (code ${status.code})` : ''}. Close this tab or open a new terminal.</div>}
      {status.kind === 'disconnected' && <div className="term-banner">Disconnected. Reconnecting...</div>}
    </div>
  );
});
