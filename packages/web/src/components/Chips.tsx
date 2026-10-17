import { useMemo } from 'react';
import type { EffortLevel, PermissionMode } from '@workstation/protocol';
import { modelLabel } from '../lib/utils';
import { useSessions, type SessionData } from '../store/sessions';
import { Icon } from './Icon';
import { Dropdown, type MenuEntry } from './ui';

export const MODES: { id: PermissionMode; label: string; desc: string; icon: 'shield' | 'pencil' | 'list' | 'zap' | 'sparkles' }[] = [
  { id: 'default', label: 'Ask permissions', desc: 'Approve edits and commands one by one', icon: 'shield' },
  { id: 'acceptEdits', label: 'Auto-accept edits', desc: 'Edit files freely, still ask for commands', icon: 'pencil' },
  { id: 'plan', label: 'Plan mode', desc: 'Explore and propose a plan before changing anything', icon: 'list' },
  { id: 'auto', label: 'Auto', desc: 'A classifier approves safe actions for you', icon: 'sparkles' },
  { id: 'bypassPermissions', label: 'Bypass permissions', desc: 'Run everything without asking. Use with care', icon: 'zap' },
];
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

export function currentModel(session: SessionData, defaultModel?: string) {
  return session.runtime.model ?? session.conv.init?.model ?? defaultModel;
}

export function ModelChip({ session }: { session: SessionData }) {
  const setModel = useSessions((s) => s.setModel);
  const def = useSessions((s) => s.config?.defaultModel);
  const list = useModelList(session);
  const cur = currentModel(session, def);
  const items: MenuEntry[] = [{ heading: 'Model' }, ...list.map((m) => ({ id: m.id, label: m.label, description: m.description, checked: m.id === cur, onSelect: () => setModel(session.id, m.id) }))];
  return <Dropdown title="Model" items={items} trigger={() => <><span>{modelLabel(cur)}</span><Icon name="chevron-down" size={12} /></>} />;
}

export function ModeChip({ session }: { session: SessionData }) {
  const setMode = useSessions((s) => s.setMode);
  const mode = MODES.find((m) => m.id === session.runtime.permissionMode) ?? MODES[0];
  const items: MenuEntry[] = [{ heading: 'Permission mode' }, ...MODES.map((m) => ({ id: m.id, label: m.label, description: m.desc, icon: m.icon, checked: m.id === mode.id, onSelect: () => setMode(session.id, m.id) }))];
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
