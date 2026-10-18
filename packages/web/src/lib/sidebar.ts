import type { SessionStatus } from '../store/sessions';

/** A session that wants you (or is busy) is never hidden behind "Show N more": the first `limit` by recency, plus every needs-input / running / starting row and the open one. Old finished or errored rows stay foldable. */
export function visibleSessions<T extends { id: string; status: SessionStatus }>(es: T[], limit: number, activeId?: string | null): T[] {
  return es.filter((e, i) => i < limit || e.status === 'needs-input' || e.status === 'running' || e.status === 'starting' || e.id === activeId);
}
