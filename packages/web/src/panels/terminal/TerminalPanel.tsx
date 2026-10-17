import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/ui';
import { useUi } from '../../store/ui';
import { registerPanel, type PanelProps } from '../registry';
import { loadTabs, newTab, saveTabs, type TermTab } from './termStore';
import { TermView, type TermHandle } from './TermView';
import './terminal.css';

function TerminalPanel({ sessionId, cwd }: PanelProps) {
  const [tabs, setTabs] = useState<TermTab[]>(() => { const t = loadTabs(sessionId); return t.length ? t : [newTab([])]; });
  const [active, setActive] = useState<string>(() => tabs[0]!.id);
  const refs = useRef<Record<string, TermHandle | null>>({});
  useEffect(() => { saveTabs(sessionId, tabs); }, [sessionId, tabs]);

  const add = () => { const t = newTab(tabs); setTabs([...tabs, t]); setActive(t.id); };
  const close = (id: string) => {
    // Tell the server to kill the shell, then drop the tab. Done via a short-lived socket-free path: the TermView
    // owns the socket, so unmounting alone only detaches; explicit kill goes through the handle's channel.
    killTerminal(id);
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (active === id) setActive(rest[rest.length - 1]?.id ?? '');
    if (!rest.length) { const t = newTab([]); setTabs([t]); setActive(t.id); }
  };
  const copy = async () => {
    const ok = await refs.current[active]?.copy();
    useUi.getState().toast(ok ? { kind: 'success', title: 'Copied selection' } : { kind: 'info', title: 'Nothing selected' });
  };

  return (
    <div className="term-panel">
      <div className="term-bar">
        <div className="term-tabs" role="tablist" aria-label="Terminals">
          {tabs.map((t) => (
            <div key={t.id} className={`term-tab${t.id === active ? ' on' : ''}`}>
              <button type="button" role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)}><Icon name="terminal" size={12} />{t.title}</button>
              <button type="button" className="term-x" aria-label={`Close ${t.title}`} onClick={() => close(t.id)}><Icon name="x" size={11} /></button>
            </div>
          ))}
        </div>
        <IconButton icon="plus" label="New terminal" onClick={add} />
        <IconButton icon="copy" label="Copy selection" onClick={copy} />
        <IconButton icon="trash" label="Clear terminal" onClick={() => refs.current[active]?.clear()} />
      </div>
      <div className="term-stack">
        {tabs.map((t) => <TermView key={t.id} id={t.id} cwd={cwd} visible={t.id === active} ref={(h) => { refs.current[t.id] = h; }} />)}
      </div>
    </div>
  );
}

/** Explicit kill: open a brief socket to the same id and send `kill` (detach alone keeps the shell alive). */
async function killTerminal(id: string) {
  const { getServerBase, getToken } = await import('../../lib/storage');
  const q = new URLSearchParams({ id });
  const t = getToken();
  if (t) q.set('token', t);
  try {
    const ws = new WebSocket(`${getServerBase().replace(/^http/, 'ws')}/ws/terminal?${q}`);
    ws.onmessage = (ev) => { try { if (JSON.parse(String(ev.data)).type === 'ready') { ws.send(JSON.stringify({ type: 'kill' })); } } catch { /* ignore */ } };
    setTimeout(() => ws.close(), 3000);
  } catch { /* ignore */ }
}

registerPanel({ id: 'terminal', title: 'Terminal', icon: 'terminal', order: 60, component: TerminalPanel });
