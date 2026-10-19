import { useEffect, useMemo, useState } from 'react';
import { SETTING_SOURCES, type ConfigItem, type ConfigItemKind, type ConfigOrigin, type LoadedConfig, type SettingSourceId } from '@workstation/protocol';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';
import { useSessions } from '../store/sessions';
import { useUi } from '../store/ui';
import './panels.css';

export const SOURCE_LABEL: Record<SettingSourceId, string> = { user: 'User', project: 'Project', local: 'Local' };
const SOURCE_HINT: Record<SettingSourceId, string> = { user: '~/.claude', project: '.claude/ + CLAUDE.md', local: '.claude/settings.local.json' };
const ORIGINS: Array<{ id: ConfigOrigin; label: string }> = [
  { id: 'user', label: 'User' }, { id: 'project', label: 'Project' }, { id: 'local', label: 'Local' }, { id: 'plugin', label: 'Plugins' }, { id: 'builtin', label: 'Built-in' },
];
const KIND_LABEL: Record<ConfigItemKind, string> = { memory: 'Memory', skill: 'Skills', command: 'Commands', agent: 'Agents', mcp: 'MCP servers', hook: 'Hooks', plugin: 'Installed' };
const KIND_ORDER: ConfigItemKind[] = ['memory', 'skill', 'command', 'agent', 'plugin', 'mcp', 'hook'];
/** kinds listed as one wrapped line of names; the rest get a row each (they carry a path / status / command) */
const INLINE: ConfigItemKind[] = ['skill', 'command', 'agent', 'plugin'];

export const sourcesText = (s: readonly SettingSourceId[]) => (s.length ? s.map((x) => SOURCE_LABEL[x]).join(' · ') : 'none');

export function openSourcesSettings() { useUi.getState().set({ settingsOpen: true, settingsFocus: 'sources' }); }

/** What the agent loaded for a live session (GET /api/sessions/:id/loaded-config), refreshed when the session's init or rules change. */
export function useLoadedConfig(sessionId: string) {
  const live = useSessions((s) => !!s.sessions[sessionId]?.live);
  const initKey = useSessions((s) => { const i = s.sessions[sessionId]?.conv.init; return i ? `${i.skills.length}/${i.slashCommands.length}/${i.agents.length}/${i.mcpServers.length}` : ''; });
  const cfgKey = useSessions((s) => (s.config?.settingSources ?? ['all']).join());
  const rulesKey = useSessions((s) => s.sessions[sessionId]?.runtime.rules?.length ?? 0);
  const [state, setState] = useState<{ data?: LoadedConfig; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!live) { setState((x) => ({ ...x, loading: false })); return; }
    let dead = false;
    setState((x) => ({ ...x, loading: true }));
    api.loadedConfig(sessionId).then((data) => { if (!dead) setState({ data, loading: false }); }).catch((e: Error) => { if (!dead) setState((x) => ({ ...x, error: e.message, loading: false })); });
    return () => { dead = true; };
  }, [sessionId, live, initKey, rulesKey, cfgKey]);
  return state;
}

function ItemRows({ items }: { items: ConfigItem[] }) {
  const byKind = useMemo(() => KIND_ORDER.map((k) => ({ k, list: items.filter((i) => i.kind === k) })).filter((g) => g.list.length), [items]);
  return (
    <>
      {byKind.map(({ k, list }) => INLINE.includes(k) ? (
        <div key={k} className="lc-line" data-kind={k}><span className="lc-kind">{KIND_LABEL[k]}</span><span className="lc-names">{list.map((i) => (i.kind === 'plugin' && i.detail ? `${i.name} ${i.detail}` : i.name)).join(', ')}</span></div>
      ) : list.map((i, n) => (
        <div key={`${k}${n}`} className="lc-line" data-kind={k} title={i.command ? `${i.detail ?? i.name}\n${i.command}` : i.detail ? `${i.name} · ${i.detail}` : i.name}>
          <span className="lc-kind">{k === 'mcp' ? 'MCP' : KIND_LABEL[k].replace(/s$/, '')}</span>
          {k === 'hook' ? <><span className="lc-main">{i.detail ?? i.name}</span><code className="lc-cmd">{i.command}</code></>
            : <><span className="lc-main">{i.name}</span>{i.detail && <span className="lc-meta">{i.detail}</span>}</>}
        </div>
      )))}
    </>
  );
}

export function LoadedConfigBody({ sessionId }: { sessionId: string }) {
  const { data, error, loading } = useLoadedConfig(sessionId);
  const started = useSessions((s) => !!s.sessions[sessionId]?.runtime.settingSources);
  const sessionSources = useSessions((s) => s.sessions[sessionId]?.runtime.settingSources);
  if (!data) {
    return (
      <p className="ov-note">
        {loading ? <><Spinner size={11} /> Reading what the agent loaded…</> : error ? `Could not read the loaded configuration: ${error}` : started ? 'Not available for a session that is not running.' : 'Appears once the session has started.'}
        {sessionSources && !loading && <> Config sources: {sourcesText(sessionSources)}.</>}
      </p>
    );
  }
  const differs = data.sources.join() !== data.current.join();
  const rules = (['user', 'project', 'local', 'session'] as const).filter((k) => data.rules[k]).map((k) => `${data.rules[k]} ${k === 'session' ? 'this session' : k}`);
  const bc = data.builtinCounts;
  return (
    <div className="lc" data-testid="loaded-config">
      <div className="lc-sources" data-testid="lc-sources">
        {SETTING_SOURCES.map((id) => <span key={id} className={`pill${data.sources.includes(id) ? ' pill-ok' : ' lc-off'}`} title={`${SOURCE_HINT[id]}${data.sources.includes(id) ? '' : ' (not loaded in this session)'}`}>{SOURCE_LABEL[id]}{data.sources.includes(id) ? '' : ' off'}</span>)}
        <span className="muted small lc-fixed">fixed at session start</span>
      </div>
      {differs && <p className="ov-note" data-testid="lc-differs">Settings now load {sourcesText(data.current)}; that applies to new sessions.</p>}
      {data.hasHooks && (
        <p className="lc-hooks" role="note" data-testid="lc-hooks-badge"><Icon name="alert" size={12} /> Hooks run commands on your machine <button type="button" className="link-btn" onClick={openSourcesSettings}>Change in Settings</button></p>
      )}
      {ORIGINS.map(({ id, label }) => {
        const items = data.items.filter((i) => i.origin === id);
        const isBuiltin = id === 'builtin';
        const off = (id === 'user' || id === 'project' || id === 'local') && !data.sources.includes(id);
        if (!items.length && !(isBuiltin && (bc.skills || bc.commands || bc.agents))) return off ? <div key={id} className="lc-group off" data-origin={id}><div className="lc-head"><b>{label}</b><span className="muted small">off for this session</span></div></div> : null;
        return (
          <div key={id} className="lc-group" data-origin={id}>
            <div className="lc-head"><b>{label}</b><span className="muted small">{items.length || ''}</span></div>
            <ItemRows items={items} />
            {isBuiltin && (bc.skills || bc.commands || bc.agents) ? <div className="lc-line"><span className="lc-kind">Included</span><span className="lc-names">{[bc.skills && `${bc.skills} skills`, bc.commands && `${bc.commands} commands`, bc.agents && `${bc.agents} agents`].filter(Boolean).join(' · ')}</span></div> : null}
          </div>
        );
      })}
      {data.items.length === 0 && <p className="ov-note">Nothing from your machine was loaded.</p>}
      <p className="lc-rules" data-testid="lc-rules"><span className="lc-kind">Permission rules</span><span className="lc-names">{rules.length ? rules.join(' · ') : 'none saved'}</span></p>
      {data.notes.map((n) => <p key={n} className="ov-note">{n}</p>)}
      {!data.live && <p className="ov-note">The agent could not be asked just now: lists may be incomplete.</p>}
    </div>
  );
}
