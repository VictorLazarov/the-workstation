import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { TodoList } from '../components/ToolCards';
import { useSessions } from '../store/sessions';
import { registerPanel, type PanelProps } from './registry';

function PlanPanel({ sessionId }: PanelProps) {
  const conv = useSessions((s) => s.sessions[sessionId]?.conv);
  const todos = conv?.todos ?? [];
  const done = todos.filter((t) => t.status === 'completed').length;
  const plan = conv?.plan;
  if (!todos.length && !plan) {
    return (
      <div className="panel-empty">
        <Icon name="list-checks" size={22} />
        <b>No plan yet</b>
        <span>Claude's checklist and any proposed plan show up here as it works.</span>
      </div>
    );
  }
  return (
    <div className="plan-panel">
      {todos.length > 0 && (
        <section>
          <div className="panel-title"><span>Progress</span><span className="muted">{done}/{todos.length}</span></div>
          <div className="progress" role="progressbar" aria-valuenow={done} aria-valuemax={todos.length}><i style={{ width: `${(done / todos.length) * 100}%` }} /></div>
          <TodoList todos={todos} />
        </section>
      )}
      {plan && (
        <section>
          <div className="panel-title"><span>Proposed plan</span></div>
          <div className="plan-md"><Markdown text={plan} /></div>
        </section>
      )}
    </div>
  );
}

registerPanel({
  id: 'plan', title: 'Plan', icon: 'list-checks', order: 10, component: PlanPanel,
  useBadge: (id) => useSessions((s) => { const t = s.sessions[id]?.conv.todos; return t?.length ? `${t.filter((x) => x.status === 'completed').length}/${t.length}` : undefined; }),
});
