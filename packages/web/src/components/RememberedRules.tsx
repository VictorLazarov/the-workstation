import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PermissionRuleEntry } from '@workstation/protocol';
import { api } from '../lib/api';
import { projectName, sessionProject, useSessions } from '../store/sessions';
import { useUi } from '../store/ui';
import { IconButton, Spinner } from './ui';

const SOURCE_LABEL: Record<PermissionRuleEntry['source'], string> = { local: 'This project, private', project: 'This project, shared', user: 'Your user settings' };

/**
 * Permission rules Claude Code applies in a project: the ones "Always allow" saved (.claude/settings.local.json, removable here)
 * and the shared/user ones (read-only: they are yours to edit by hand). Session-only rules are listed for the open session.
 */
export function RememberedRules({ active }: { active: boolean }) {
  const sessions = useSessions((s) => s.sessions);
  const projects = useSessions((s) => s.projects);
  const activeId = useSessions((s) => s.activeId);
  const current = activeId ? sessions[activeId] : undefined;
  // the server files rules under the main checkout of whatever directory it is given, so projects are what to offer (also for worktree sessions)
  const dirs = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p, projectName(p));
    for (const s of Object.values(sessions)) if (!s.isDraft && sessionProject(s)) m.set(sessionProject(s), projectName(sessionProject(s)));
    if (current) m.set(sessionProject(current), projectName(sessionProject(current)));
    return [...m.entries()];
  }, [projects, sessions, current]);
  const [dir, setDir] = useState('');
  const [rules, setRules] = useState<PermissionRuleEntry[] | null>(null);
  const [err, setErr] = useState('');
  const effectiveDir = dir && dirs.some(([d]) => d === dir) ? dir : (current ? sessionProject(current) : '') || dirs[0]?.[0] || '';

  const load = useCallback(async () => {
    if (!effectiveDir) { setRules([]); return; }
    try { setErr(''); setRules((await api.permissionRules(effectiveDir)).rules); } catch (e) { setErr((e as Error).message); setRules([]); }
  }, [effectiveDir]);
  useEffect(() => { if (active) { setRules(null); void load(); } }, [active, load]);

  const remove = async (r: PermissionRuleEntry) => {
    const ok = await useUi.getState().ask({ title: 'Forget this rule?', body: `${r.rule} will ask for permission again, in running sessions too.`, confirmLabel: 'Forget rule', danger: true });
    if (!ok) return;
    try { await api.removePermissionRule(effectiveDir, r.behavior, r.rule); await load(); } catch (e) { useUi.getState().toast({ kind: 'error', title: 'Could not remove the rule', body: (e as Error).message }); }
  };
  const sessionRules = (current?.runtime.rules ?? []).filter((r) => r.destination === 'session');

  return (
    <section data-testid="remembered-rules">
      <h3>Remembered permissions</h3>
      <p className="muted small">What “Always allow” saved, per project. Forgetting a rule makes Claude ask again.</p>
      {dirs.length > 0 && (
        <label className="lbl">Project
          <select className="field" value={effectiveDir} onChange={(e) => setDir(e.target.value)} aria-label="Project">{dirs.map(([d, n]) => <option key={d} value={d} title={d}>{n}</option>)}</select>
        </label>
      )}
      {err && <p className="perm-reason" role="alert">{err}</p>}
      {rules === null ? <p className="muted small"><Spinner size={11} /> Loading…</p>
        : rules.length === 0 && !sessionRules.length ? <p className="muted small">No saved rules for this project.</p> : (
          <ul className="rules-list">
            {rules.map((r) => (
              <li key={`${r.source}:${r.behavior}:${r.rule}`} className="rule-row">
                <span className={`rule-kind rk-${r.behavior}`}>{r.behavior === 'allow' ? 'Allow' : r.behavior === 'deny' ? 'Deny' : 'Ask'}</span>
                <code className="rule-text" title={r.rule}>{r.rule}</code>
                <span className="muted small rule-src">{SOURCE_LABEL[r.source]}</span>
                {r.removable ? <IconButton icon="trash" label={`Forget ${r.rule}`} size={14} onClick={() => void remove(r)} /> : <span className="rule-lock muted small" title="Edit the settings file by hand to change this">read-only</span>}
              </li>
            ))}
            {sessionRules.map((r, i) => (
              <li key={`s${i}`} className="rule-row">
                <span className="rule-kind rk-allow">Allow</span>
                <code className="rule-text">{r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName}</code>
                <span className="muted small rule-src">This session only</span>
                <span className="rule-lock muted small" title="Gone when the session ends">temporary</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
