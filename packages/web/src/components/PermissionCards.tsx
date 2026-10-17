import { useState } from 'react';
import type { PermissionDecision } from '@workstation/protocol';
import type { PermissionRequest, ToolResult, ToolUseBlock } from '../lib/types';
import { str, toolTitle } from '../lib/tools';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import type { ToolStatus } from './ToolCards';
import { Shell } from './ToolCards';

type Respond = (d: PermissionDecision) => void;

function describe(perm: PermissionRequest): string {
  if (perm.title) return perm.title;
  switch (perm.toolName) {
    case 'Bash': return 'Claude wants to run this command';
    case 'Edit': case 'MultiEdit': return 'Claude wants to edit this file';
    case 'Write': return 'Claude wants to write this file';
    case 'WebFetch': return 'Claude wants to fetch this URL';
    default: return `Claude wants to use ${perm.toolName}`;
  }
}

/** Allow once / Always allow / Deny with feedback. */
export function PermissionActions({ perm, onRespond, compact }: { perm: PermissionRequest; onRespond: Respond; compact?: boolean }) {
  const [denying, setDenying] = useState(false);
  const [feedback, setFeedback] = useState('');
  return (
    <div className="perm" role="group" aria-label="Permission request">
      {!compact && (
        <div className="perm-msg">
          <Icon name="shield" size={15} />
          <div>
            <div className="perm-title">{describe(perm)}</div>
            {(perm.description || perm.decisionReason || perm.blockedPath) && (
              <div className="perm-reason">{[perm.description, perm.decisionReason, perm.blockedPath && `Path: ${perm.blockedPath}`].filter(Boolean).join(' · ')}</div>
            )}
          </div>
        </div>
      )}
      {denying ? (
        <div className="perm-deny">
          <textarea
            autoFocus rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Optional: tell Claude what to do instead"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onRespond({ behavior: 'deny', message: feedback || undefined }); if (e.key === 'Escape') setDenying(false); }}
          />
          <div className="perm-actions">
            <button type="button" className="btn danger" onClick={() => onRespond({ behavior: 'deny', message: feedback || undefined })}>Deny</button>
            <button type="button" className="btn ghost" onClick={() => setDenying(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="perm-actions">
          <button type="button" className="btn primary" data-perm-allow onClick={() => onRespond({ behavior: 'allow' })}>Allow once</button>
          {perm.hasSuggestions && <button type="button" className="btn" onClick={() => onRespond({ behavior: 'allow', remember: true })} title="Allow and remember this choice for similar requests">Always allow</button>}
          <button type="button" className="btn ghost" onClick={() => setDenying(true)}>Deny…</button>
        </div>
      )}
    </div>
  );
}

/** Fallback for permission requests whose tool_use block is not in the timeline. */
export function PermissionDock({ perm, onRespond }: { perm: PermissionRequest; onRespond: Respond }) {
  const block: ToolUseBlock = { type: 'tool_use', id: perm.toolUseID, name: perm.toolName, input: perm.input, final: true };
  const t = toolTitle(block);
  return (
    <Shell kind="other" status="waiting" forceOpen title={t.verb} subtitle={t.subject}>
      <pre className="output"><code>{JSON.stringify(perm.input, null, 2).slice(0, 1500)}</code></pre>
      <PermissionActions perm={perm} onRespond={onRespond} />
    </Shell>
  );
}

interface QOption { label: string; description?: string }
interface Q { question: string; header?: string; multiSelect?: boolean; options: QOption[] }

export function QuestionCard({ block, perm, result, status, onRespond }: {
  block: ToolUseBlock; perm?: PermissionRequest; result?: ToolResult; status: ToolStatus; onRespond: Respond;
}) {
  const qs = (Array.isArray(block.input.questions) ? block.input.questions : []) as Q[];
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [answeredSummary, setAnswered] = useState<{ q: string; a: string }[] | null>(null);
  const answer = (i: number) => [...(sel[i] ?? []), ...(other[i]?.trim() ? [other[i].trim()] : [])];
  const complete = qs.length > 0 && qs.every((_, i) => answer(i).length > 0);

  const submit = () => {
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => { answers[q.question] = answer(i).join(', '); });
    setAnswered(qs.map((q, i) => ({ q: q.question, a: answer(i).join(', ') })));
    onRespond({ behavior: 'allow', updatedInput: { ...block.input, answers } });
  };

  if (!perm) {
    return (
      <Shell kind="ask" status={status} defaultOpen title="Question" subtitle={status === 'denied' || result?.isError ? 'skipped' : 'answered'}>
        <div className="qa-done">
          {(answeredSummary ?? qs.map((q) => ({ q: q.question, a: '' }))).map((x, i) => (
            <div key={i} className="qa-row"><div className="qa-q">{x.q}</div>{x.a && <div className="qa-a">{x.a}</div>}</div>
          ))}
          {!answeredSummary && result && <div className="qa-result">{result.content}</div>}
        </div>
      </Shell>
    );
  }
  return (
    <Shell kind="ask" status="waiting" forceOpen title="Claude has a question" subtitle={qs.length > 1 ? `${qs.length} questions` : undefined}>
      <div className="qcard">
        {qs.map((q, i) => (
          <fieldset key={i} className="q">
            <legend>{q.header && <span className="q-tag">{q.header}</span>}{q.question}</legend>
            <div className="q-opts">
              {q.options.map((o) => {
                const on = (sel[i] ?? []).includes(o.label);
                return (
                  <button
                    type="button" key={o.label} className={`q-opt${on ? ' on' : ''}`} role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on}
                    onClick={() => setSel((s) => {
                      const cur = s[i] ?? [];
                      return { ...s, [i]: q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label] };
                    })}
                  >
                    <span className={`q-mark ${q.multiSelect ? 'box' : 'radio'}`}>{on && <Icon name="check" size={10} />}</span>
                    <span><span className="q-label">{o.label}</span>{o.description && <span className="q-desc">{o.description}</span>}</span>
                  </button>
                );
              })}
              <input
                className="q-other" placeholder="Other…" value={other[i] ?? ''} aria-label="Other answer"
                onChange={(e) => { const v = e.target.value; setOther((o) => ({ ...o, [i]: v })); if (!q.multiSelect && v) setSel((s) => ({ ...s, [i]: [] })); }}
              />
            </div>
          </fieldset>
        ))}
        <div className="perm-actions">
          <button type="button" className="btn primary" disabled={!complete} onClick={submit}>Submit answer{qs.length > 1 ? 's' : ''}</button>
          <button type="button" className="btn ghost" onClick={() => onRespond({ behavior: 'deny', message: 'The user declined to answer.' })}>Skip</button>
        </div>
      </div>
    </Shell>
  );
}

export function PlanCard({ block, perm, result, status, sessionId, onRespond }: {
  block: ToolUseBlock; perm?: PermissionRequest; result?: ToolResult; status: ToolStatus; sessionId: string; onRespond: Respond;
}) {
  const plan = str(block.input.plan);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const approve = (mode?: 'acceptEdits') => {
    // `setMode` rides on the approval itself so it is applied atomically with leaving plan mode (a separate set.permissionMode races it)
    onRespond({ behavior: 'allow', updatedInput: editing ? { ...block.input, plan: draft } : undefined, ...(mode ? { setMode: mode } : {}) });
  };
  return (
    <Shell kind="plan" status={perm ? 'waiting' : status} defaultOpen forceOpen={!!perm} title="Plan" subtitle={perm ? 'awaiting your review' : result?.isError || status === 'denied' ? 'not approved' : status === 'done' ? 'approved' : undefined}>
      <div className="plan">
        {editing ? <textarea className="plan-edit" value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(18, draft.split('\n').length + 2)} aria-label="Edit plan" /> : <Markdown text={plan} />}
        {perm && !rejecting && (
          <div className="perm-actions">
            <button type="button" className="btn primary" onClick={() => approve()}>{editing ? 'Approve edited plan' : 'Approve plan'}</button>
            <button type="button" className="btn" onClick={() => approve('acceptEdits')} title="Approve and auto-accept file edits for the rest of the session">Approve &amp; auto-accept edits</button>
            <button type="button" className="btn ghost" onClick={() => setEditing(!editing)}>{editing ? 'Discard edits' : 'Edit'}</button>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>Keep planning…</button>
          </div>
        )}
        {perm && rejecting && (
          <div className="perm-deny">
            <textarea autoFocus rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What should change in the plan?" />
            <div className="perm-actions">
              <button type="button" className="btn danger" onClick={() => onRespond({ behavior: 'deny', message: feedback || 'The user rejected the plan.' })}>Send feedback</button>
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
