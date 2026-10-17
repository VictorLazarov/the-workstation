import { ls } from '../../lib/storage';
import { uid } from '../../lib/utils';

export interface TermTab { id: string; title: string }
const key = (sid: string) => `ws.terminals.${sid}`;

/** Terminal tabs per session, persisted so a reload reattaches (server replays scrollback). */
export function loadTabs(sessionId: string): TermTab[] {
  const v = ls.getJson<TermTab[]>(key(sessionId), []);
  return Array.isArray(v) ? v.filter((t) => t && typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t.id)) : [];
}
export function saveTabs(sessionId: string, tabs: TermTab[]) { ls.setJson(key(sessionId), tabs); }
export function newTab(existing: TermTab[]): TermTab {
  const used = new Set(existing.map((t) => t.title));
  let n = 1;
  while (used.has(`Terminal ${n}`)) n++;
  return { id: uid('term').replace(/[^A-Za-z0-9_-]/g, ''), title: `Terminal ${n}` };
}
