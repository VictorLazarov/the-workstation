import { useRef, useState } from 'react';
import { relPath } from '../lib/utils';
import { refreshGit } from '../panels/changes/store';
import { useSessions } from '../store/sessions';
import { useUi } from '../store/ui';
import { Icon } from './Icon';
import { MenuList, Popover, type MenuEntry } from './ui';

/** What the SDK's file checkpoints cannot restore. Shown in every confirmation that touches files. */
export const REWIND_LIMITS = 'Not restored: changes made through Bash or other commands (sed, npm install, formatters, git, moving or deleting files) and some edits made by subagents. Edits you made yourself to the same files since this message are overwritten.';

interface DryRun { canRewind?: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }

/** Preview which files a code rewind would restore (the SDK's dry run). Resolves to null when there is nothing to restore or it is unavailable (already toasted). */
async function previewFiles(sessionId: string, uuid: string): Promise<{ details: string[]; summary: string } | null> {
  const { toast } = useUi.getState();
  let r: DryRun | undefined;
  try { r = (await useSessions.getState().rewind(sessionId, uuid, true)) as DryRun | undefined; } catch (e) { toast({ kind: 'error', title: 'Rewind unavailable', body: (e as Error).message }); return null; }
  if (r && r.canRewind === false) { toast({ kind: 'info', title: 'No files to restore', body: r.error ?? 'No file checkpoint exists for this message.' }); return null; }
  const files = r?.filesChanged ?? [];
  const cwd = useSessions.getState().sessions[sessionId]?.cwd;
  if (!files.length) return { details: [], summary: 'The agent changed no files through its file tools after this message, so there is nothing to restore.' };
  return {
    details: [...files.slice(0, 8).map((f) => relPath(f, cwd)), ...(files.length > 8 ? [`and ${files.length - 8} more`] : [])],
    summary: `${files.length} file${files.length === 1 ? '' : 's'} will be restored (+${r?.insertions ?? 0} −${r?.deletions ?? 0} lines).`,
  };
}

export type RewindKind = 'code' | 'conversation' | 'both';

export async function runRewind(kind: RewindKind, sessionId: string, uuid: string) {
  const { ask, toast } = useUi.getState();
  const S = useSessions.getState();
  const cwd = S.sessions[sessionId]?.cwd ?? '';
  let files: { details: string[]; summary: string } | null = null;
  if (kind !== 'conversation') {
    files = await previewFiles(sessionId, uuid);
    if (!files) return;
  }
  const conv = 'A new session continues from the conversation as it was before this message. This session stays exactly as it is.';
  const ok = await ask(
    kind === 'code'
      ? { title: 'Restore files to before this message?', body: 'File edits the agent made with its file tools after this message are undone. The conversation stays as it is.', details: files!.details, summary: files!.summary, note: REWIND_LIMITS, confirmLabel: 'Restore files', danger: true }
      : kind === 'conversation'
        ? { title: 'Rewind the conversation to before this message?', body: `${conv} Files are not touched: the code stays as it is now.`, confirmLabel: 'Rewind conversation' }
        : { title: 'Restore code and conversation?', body: `File edits made after this message are undone, and ${conv.charAt(0).toLowerCase()}${conv.slice(1)}`, details: files!.details, summary: files!.summary, note: REWIND_LIMITS, confirmLabel: 'Restore both', danger: true },
  );
  if (!ok) return;
  if (kind !== 'conversation') {
    try {
      const r = (await S.rewind(sessionId, uuid, false)) as DryRun | undefined;
      if (r && r.canRewind === false) { toast({ kind: 'error', title: 'Files were not restored', body: r.error }); return; }
      void refreshGit(sessionId, cwd);
      toast({ kind: 'success', title: 'Files restored', body: 'Changes made through Bash were not touched.' });
    } catch (e) { toast({ kind: 'error', title: 'Rewind failed', body: (e as Error).message }); return; }
  }
  if (kind !== 'code') S.rewindConversation(sessionId, uuid);
}

/** The per-message "Rewind" button: restore code, conversation, or both. */
export function RewindMenu({ sessionId, uuid, first }: { sessionId: string; uuid: string; first: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const live = useSessions((s) => !!s.sessions[sessionId]?.live);
  const running = useSessions((s) => (s.sessions[sessionId]?.runtime.status ?? 'idle') !== 'idle');
  const noFiles = !live ? 'Resume the session (send a message) to restore files' : running ? 'Wait until the agent is idle' : undefined;
  const noConv = first ? 'This is the first message: nothing comes before it' : running ? 'Wait until the agent is idle' : undefined;
  const items: MenuEntry[] = [
    { heading: 'Rewind to before this message' },
    { id: 'code', label: 'Restore code', description: noFiles ?? 'Undo the agent\'s file edits. Bash changes are not covered', icon: 'file-edit', disabled: !!noFiles, onSelect: () => void runRewind('code', sessionId, uuid) },
    { id: 'conversation', label: 'Restore conversation', description: noConv ?? 'Continue in a new session from here. Files stay as they are', icon: 'fork', disabled: !!noConv, onSelect: () => void runRewind('conversation', sessionId, uuid) },
    { id: 'both', label: 'Restore code and conversation', description: noFiles ?? noConv ?? 'Both of the above', icon: 'undo', disabled: !!(noFiles ?? noConv), onSelect: () => void runRewind('both', sessionId, uuid) },
  ];
  return (
    <>
      <button ref={ref} type="button" className="icon-btn" aria-label="Rewind…" title="Rewind to before this message: code, conversation, or both" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="undo" size={14} /></button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} align="end" width={300}><MenuList items={items} onClose={() => setOpen(false)} /></Popover>
    </>
  );
}
