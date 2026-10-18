import { memo, useMemo, useState, type ReactNode } from 'react';
import type { PermissionDecision } from '@workstation/protocol';
import type { Conversation, ImageRef, PermissionRequest, ResultItem, ThinkingBlock, UserItem } from '../lib/types';
import { buildRows, latestTodoId, type Row } from '../lib/tools';
import { formatCost, formatDuration, relPath, truncate } from '../lib/utils';
import { useSessions } from '../store/sessions';
import { useUi } from '../store/ui';
import { ExpandScope, useExpanded } from '../lib/expand';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ExploreGroup, ToolCard } from './ToolCards';
import { RewindMenu } from './Rewind';
import { CopyButton } from './ui';

export const Thinking = memo(function Thinking({ block, streaming }: { block: ThinkingBlock; streaming: boolean }) {
  const [isOpen, setOpen] = useExpanded(false);
  if (block.redacted) return <div className="thinking"><span className="thinking-head dim"><Icon name="brain" size={14} /> Reasoning (hidden)</span></div>;
  const first = block.text.trim().split('\n')[0];
  return (
    <div className={`thinking${streaming ? ' live' : ''}${isOpen ? ' open' : ''}`}>
      <button type="button" className="thinking-head" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <Icon name="brain" size={14} />
        <span className={streaming ? 'shimmer' : ''}>{streaming ? 'Thinking…' : 'Thought'}</span>
        {!isOpen && first && <span className="thinking-preview">{truncate(first, 110)}</span>}
        <Icon name="chevron-right" size={13} className="tool-chev" />
      </button>
      {isOpen && <div className="thinking-body">{block.text}</div>}
      {!isOpen && streaming && block.text && <div className="thinking-stream">{block.text.slice(-220)}</div>}
    </div>
  );
});

function UserMessage({ item, sessionId, first }: { item: UserItem; sessionId: string; first: boolean }) {
  return (
    <div className={`msg-user${item.pending ? ' pending' : ''}${item.failed ? ' failed' : ''}`}>
      <div className="msg-user-bubble">
        {item.images.length > 0 && <div className="msg-images">{item.images.map((im, i) => <Img key={i} im={im} />)}</div>}
        {item.text && <div className="msg-user-text">{item.text}</div>}
      </div>
      <div className="msg-actions">
        <CopyButton text={item.text} label="Copy message" />
        {item.uuid && <RewindMenu sessionId={sessionId} uuid={item.uuid} first={first} />}
      </div>
      {item.failed && <div className="msg-failed">Not sent</div>}
    </div>
  );
}

function Img({ im }: { im: ImageRef }) {
  const src = im.url ?? (im.dataBase64 ? `data:${im.mediaType};base64,${im.dataBase64}` : '');
  return src ? <img className="msg-img" src={src} alt={im.name ?? 'attached image'} /> : null;
}

function ErrorAction({ action, sessionId }: { action?: 'settings' | 'retry' | 'close-idle'; sessionId: string }) {
  if (action === 'settings') return <button type="button" className="link-btn banner-action" onClick={() => useUi.getState().set({ settingsOpen: true })}>Open Settings</button>;
  if (action === 'close-idle') return <button type="button" className="link-btn banner-action" onClick={() => useSessions.getState().closeIdleSessions(sessionId)}>Close idle sessions</button>;
  if (action === 'retry') return <button type="button" className="link-btn banner-action" onClick={() => useSessions.getState().retryLast(sessionId)}>Retry</button>;
  return null;
}

function ResultFooter({ item, sessionId }: { item: ResultItem; sessionId: string }) {
  if (item.outcome === 'stopped') return <div className="result-line stopped"><Icon name="stop" size={11} fill /> Stopped</div>;
  if (item.outcome === 'reported') return null; // an error notice above already told the user why, with its action
  if (item.outcome === 'error') {
    return (
      <div className="banner error"><Icon name="alert" size={15} />
        <div><b>{item.subtype === 'error_max_turns' ? 'Reached the turn limit' : 'Something went wrong'}</b>{item.message && item.message !== 'Reached the turn limit' && <div className="banner-sub">{truncate(item.message, 300)}</div>}</div>
        <ErrorAction action={item.action} sessionId={sessionId} />
      </div>
    );
  }
  if (item.text && item.turns === 0 && !item.durationMs) return null;
  return (
    <div className="result-line">
      <Icon name="check" size={12} /> {formatDuration(item.durationMs)}
      {item.turnCostUsd > 0 && <> · {formatCost(item.turnCostUsd)}</>}
      {item.turns > 1 && <> · {item.turns} turns</>}
    </div>
  );
}

interface ListProps {
  conv: Conversation;
  laneKey: string;
  sessionId: string;
  cwd: string;
  sessionRunning: boolean;
  perms: PermissionRequest[];
  outcomes: Record<string, 'allowed' | 'denied'>;
  nested?: boolean;
}

export const RowList = memo(function RowList({ conv, laneKey, sessionId, cwd, sessionRunning, perms, outcomes, nested }: ListProps) {
  const lane = conv.lanes[laneKey];
  const rows = useMemo<Row[]>(() => buildRows(lane?.items ?? [], lane?.live?.id), [lane]);
  // the single live checklist: the most recent TodoWrite of this lane
  const latestTodo = useMemo(() => latestTodoId(rows), [rows]);
  const respond = (toolUseID: string, requestId: string) => (d: PermissionDecision) => useSessions.getState().respondPermission(sessionId, requestId, d);
  const out: ReactNode[] = [];
  let steps: ReactNode[] = [];
  let seenUser = false;
  const flush = () => { if (steps.length) { out.push(<div className="steps" key={'steps:' + out.length}>{steps}</div>); steps = []; } };
  for (const r of rows) {
    switch (r.kind) {
      case 'thinking': steps.push(<ExpandScope.Provider key={r.key} value={`${sessionId}/${r.key}`}><Thinking block={r.block} streaming={r.streaming} /></ExpandScope.Provider>); break;
      case 'explore': steps.push(<ExpandScope.Provider key={r.key} value={`${sessionId}/${r.key}`}><ExploreGroup blocks={r.blocks} results={conv.toolResults} cwd={cwd} sessionRunning={sessionRunning} /></ExpandScope.Provider>); break;
      case 'tool': {
        const b = r.block;
        const perm = perms.find((p) => p.toolUseID === b.id);
        steps.push(
          <div key={b.id} data-tool-id={b.id}>
            <ExpandScope.Provider value={`${sessionId}/${b.id}`}>
            <ToolCard
              block={b} result={conv.toolResults[b.id]} perm={perm} outcome={outcomes[b.id]} sessionRunning={sessionRunning}
              sessionId={sessionId} cwd={cwd} elapsed={conv.toolProgress[b.id]} conv={b.name === 'Task' || b.name === 'Agent' ? conv : undefined}
              task={conv.tasks[b.id]} todoLatest={b.name === 'TodoWrite' ? b.id === latestTodo : undefined} onRespond={perm ? respond(b.id, perm.requestId) : noop}
            />
            </ExpandScope.Provider>
          </div>,
        );
        break;
      }
      case 'user': flush(); out.push(<UserMessage key={r.key} item={r.item} sessionId={sessionId} first={!seenUser} />); seenUser = true; break;
      case 'text': flush(); out.push(
        <div key={r.key} className="msg-assistant">
          <Markdown text={r.block.text} streaming={r.streaming} />
          {!r.streaming && !nested && r.block.text.length > 80 && <div className="msg-actions assistant"><CopyButton text={r.block.text} label="Copy response" /></div>}
        </div>,
      ); break;
      case 'notice': flush(); out.push(r.item.level === 'error'
        ? <div key={r.key} className="banner error"><Icon name="alert" size={15} /><div>{r.item.text}</div><ErrorAction action={r.item.action} sessionId={sessionId} /></div>
        : <div key={r.key} className={`notice notice-${r.item.level}`}><Icon name={r.item.level === 'info' ? 'info' : 'alert'} size={13} /> {r.item.text}</div>); break;
      case 'result': flush(); if (!nested) out.push(<ResultFooter key={r.key} item={r.item} sessionId={sessionId} />); break;
      case 'error': flush(); out.push(<div key={r.key} className="banner error"><Icon name="alert" size={15} /><div>{r.text}</div></div>); break;
    }
  }
  flush();
  return <>{out}</>;
});
const noop = () => {};
