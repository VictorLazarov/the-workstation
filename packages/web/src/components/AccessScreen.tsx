import { useState } from 'react';
import { useSessions } from '../store/sessions';
import { Icon } from './Icon';
import { Spinner } from './ui';

/**
 * Full-screen state for a missing or rejected access token. Shown instead of the app (the server answered 401 on
 * /api/health, or this page has no token at all), so there is no "Connecting…" spinner and no endless retrying.
 */
export function AccessScreen({ reason }: { reason: 'missing' | 'invalid' }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => { setBusy(true); try { await useSessions.getState().recheckAccess(); } finally { setBusy(false); } };
  return (
    <main className="access" aria-labelledby="access-title">
      <div className="access-card" role="alert">
        <div className="empty-mark" aria-hidden="true"><Icon name="shield" size={22} /></div>
        <h1 id="access-title" className="serif">Access token missing or invalid</h1>
        <p className="muted">
          {reason === 'missing'
            ? 'This page was opened without an access token, so the server will not talk to it.'
            : 'The server did not accept the access token in this link. It may belong to an earlier run or to a different server.'}
        </p>
        <ol className="access-steps">
          <li>Find the terminal where you started The Workstation (the <code>workstation</code> command, or the container log).</li>
          <li>Open the link it printed. It ends in <code>?token=…</code></li>
          <li>Started it again, or lost the link? Run it again and use the new link.</li>
        </ol>
        <div className="access-actions">
          <button type="button" className="btn primary lg" onClick={() => void retry()} disabled={busy}>{busy ? <Spinner size={13} /> : <Icon name="refresh" size={14} />} Retry</button>
        </div>
        <p className="muted small">Nothing was sent to the server except this check. Your token is never shown here.</p>
      </div>
    </main>
  );
}
