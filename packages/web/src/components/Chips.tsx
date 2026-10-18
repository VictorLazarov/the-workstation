import { useMemo } from 'react';
import type { EffortLevel, PermissionMode } from '@workstation/protocol';
import { modelLabel } from '../lib/utils';
import { useSessions, type SessionData } from '../store/sessions';
import { useUi } from '../store/ui';
import { Icon } from './Icon';
import { Dropdown, type MenuEntry } from './ui';

export const MODES: { id: PermissionMode; label: string; desc: string; icon: 'shield' | 'pencil' | 'list' | 'zap' | 'sparkles' }[] = [
  { id: 'default', label: 'Ask permissions', desc: 'Approve edits and commands one by one', icon: 'shield' },
  { id: 'acceptEdits', label: 'Auto-accept edits', desc: 'Edit files freely, still ask for commands', icon: 'pencil' },
  { id: 'plan', label: 'Plan mode', desc: 'Explore and propose a plan before changing anything', icon: 'list' },
  { id: 'auto', label: 'Auto', desc: 'A classifier approves safe actions for you', icon: 'sparkles' },
  { id: 'bypassPermissions', label: 'Bypass permissions', desc: 'Run everything without asking. Use with care', icon: 'zap' },
];
/** Whether "Bypass permissions" can work on this server (unknown = available; the server refuses honestly otherwise). */
export function useBypass(): { available: boolean; reason?: string } {
  return useSessions((s) => s.hello?.bypass) ?? { available: true };
}
/** Modes the user can switch to right now (Shift+Tab cycling, command palette). */
export const usableModes = (bypass: { available: boolean }) => MODES.filter((m) => m.id !== 'bypassPermissions' || bypass.available);

export const EFFORTS: { id: EffortLevel; label: string }[] = [
  { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }, { id: 'max', label: 'Max' },
];

export function useModelList(session: SessionData) {
  const models = useSessions((s) => s.models);
  const config = useSessions((s) => s.config);
  return useMemo(() => {
    const ids = new Set<string>();
    const out: { id: string; label: string; description?: string }[] = [];
    for (const m of models) { ids.add(m.id); out.push(m); }
    for (const c of config?.customModels ?? []) if (!ids.has(c)) { ids.add(c); out.push({ id: c, label: modelLabel(c), description: 'Custom model' }); }
    const cur = session.runtime.model ?? session.conv.init?.model;
    if (cur && !ids.has(cur)) out.push({ id: cur, label: modelLabel(cur) });
    return out;
  }, [models, config?.customModels, session.runtime.model, session.conv.init?.model]);
}

/** Open Settings with the Model field focused (gateway users fix their model id there). */
export const openModelSettings = () => useUi.getState().set({ settingsOpen: true, settingsFocus: 'model' });

/**
 * The banner action for model_not_found: pick another model from the list (gateway models first) and the failed message is sent
 * again with it, or open Settings on the Model field. `rejected` is the id the provider refused; it is not offered again.
 */
export function ModelFixAction({ sessionId, rejected }: { sessionId: string; rejected?: string }) {
  const session = useSessions((s) => s.sessions[sessionId]);
  if (!session) return null;
  return <ModelFixInner session={session} rejected={rejected} />;
}
function ModelFixInner({ session, rejected }: { session: SessionData; rejected?: string }) {
  const list = useModelList(session).filter((m) => m.id !== rejected);
  const fix = (id: string) => { useSessions.getState().setModel(session.id, id); useSessions.getState().retryLast(session.id); };
  const items: MenuEntry[] = [{ heading: 'Use this model and retry' }, ...list.map((m) => ({ id: m.id, label: m.label, description: m.description, onSelect: () => fix(m.id) }))];
  return (
    <span className="banner-actions">
      <Dropdown className="link-btn banner-action" title="Choose another model and send the message again" items={items} trigger={() => <><span>Choose model</span><Icon name="chevron-down" size={12} /></>} />
      <button type="button" className="link-btn banner-action" onClick={openModelSettings}>Model settings</button>
    </span>
  );
}

export function currentModel(session: SessionData, defaultModel?: string) {
  return session.runtime.model ?? session.conv.init?.model ?? defaultModel;
}

export function ModelChip({ session }: { session: SessionData }) {
  const setModel = useSessions((s) => s.setModel);
  const def = useSessions((s) => s.config?.defaultModel);
  const list = useModelList(session);
  const cur = currentModel(session, def);
  const items: MenuEntry[] = [{ heading: 'Model' }, ...list.map((m) => ({ id: m.id, label: m.label, description: m.description, checked: m.id === cur, onSelect: () => setModel(session.id, m.id) })),
    'sep', { id: 'model-settings', label: 'Model settings…', description: 'Default model, custom ids, gateway aliases', icon: 'settings' as const, onSelect: openModelSettings }];
  // an alias the user picked ("sonnet") is named by the server's model list, not shown as the raw id
  const label = !cur || cur === 'default' ? modelLabel(cur) : list.find((m) => m.id === cur)?.label ?? modelLabel(cur);
  return <Dropdown title="Model" items={items} trigger={() => <><span>{label}</span><Icon name="chevron-down" size={12} /></>} />;
}

export function ModeChip({ session }: { session: SessionData }) {
  const setMode = useSessions((s) => s.setMode);
  const mode = MODES.find((m) => m.id === session.runtime.permissionMode) ?? MODES[0];
  const bypass = useBypass();
  const items: MenuEntry[] = [{ heading: 'Permission mode' }, ...MODES.map((m) => {
    const off = m.id === 'bypassPermissions' && !bypass.available;
    return { id: m.id, label: m.label, description: off ? bypass.reason : m.desc, icon: m.icon, checked: m.id === mode.id, disabled: off, onSelect: () => setMode(session.id, m.id) };
  })];
  return (
    <span className={`mode-${mode.id}`}>
      <Dropdown title="Permission mode (Shift+Tab to cycle)" items={items} trigger={() => <><Icon name={mode.icon} size={13} /><span>{mode.label}</span><Icon name="chevron-down" size={12} /></>} />
    </span>
  );
}

export function EffortChip({ session }: { session: SessionData }) {
  const setEffort = useSessions((s) => s.setEffort);
  const effort = EFFORTS.find((x) => x.id === session.runtime.effort) ?? EFFORTS[1];
  const items: MenuEntry[] = [{ heading: 'Thinking effort' }, ...EFFORTS.map((x) => ({ id: x.id, label: x.label, checked: x.id === effort.id, onSelect: () => setEffort(session.id, x.id) }))];
  return <Dropdown title="Thinking effort" items={items} trigger={() => <><Icon name="brain" size={13} /><span>{effort.label}</span><Icon name="chevron-down" size={12} /></>} />;
}

/** New-session only: run in the project folder, or in a fresh git worktree (own branch, own checkout) so parallel agents never collide. */
export function WorktreeChip({ session }: { session: SessionData }) {
  const set = useSessions((s) => s.setDraftWorktree);
  if (!session.isDraft || !session.isRepo) return null;
  const on = !!session.worktree;
  const items: MenuEntry[] = [
    { heading: 'Where the agent works' },
    { id: 'folder', label: 'Project folder', description: 'Edit the checkout you have open', icon: 'folder', checked: !on, onSelect: () => set(session.id, false) },
    { id: 'worktree', label: 'New git worktree', description: 'Own branch and checkout under .claude/worktrees. Your working tree is untouched', icon: 'layers', checked: on, onSelect: () => set(session.id, true) },
  ];
  return (
    <span className={on ? 'chip-wt on' : 'chip-wt'}>
      <Dropdown title="Where the agent works: project folder or a new git worktree" items={items} trigger={() => <><Icon name="layers" size={13} /><span>{on ? 'New worktree' : 'Project folder'}</span><Icon name="chevron-down" size={12} /></>} />
    </span>
  );
}
