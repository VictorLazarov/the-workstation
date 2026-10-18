import { Dialog } from '../components/ui';
import { badgeLabel } from '../lib/logs';
import { useLogs, useUnseenErrors } from '../store/logs';
import { LogsView } from './logs/LogsView';
import { registerPanel, type PanelProps } from './registry';

function LogsPanel({ sessionId }: PanelProps) {
  return <LogsView sessionId={sessionId} />;
}

registerPanel({
  id: 'logs', title: 'Logs', icon: 'logs', order: 70, component: LogsPanel,
  // errors that arrived while Logs was not on screen (cleared when it is shown)
  useBadge: () => badgeLabel(useUnseenErrors()),
});

/** Logs without an open session (no inspector then): Settings → View logs, the palette, a server-error toast. */
export function LogsDialog() {
  const open = useLogs((s) => s.dialogOpen);
  return (
    <Dialog open={open} onClose={() => useLogs.setState({ dialogOpen: false })} title="Logs" width={680} className="logs-dialog">
      <LogsView />
    </Dialog>
  );
}
