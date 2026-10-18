import { useLogs } from '../store/logs';

/** "View details" on an error banner: opens Logs on that session, at the entry nearest to when the banner appeared. */
export function LogsLink({ sessionId, ts, text }: { sessionId?: string; ts?: number; text?: string }) {
  return <button type="button" className="link-btn banner-action" onClick={() => useLogs.getState().openLogs({ sessionId, ts, text })}>View details</button>;
}
