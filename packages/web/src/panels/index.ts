/**
 * Panel registrations. To add an inspector tab:
 *   1. create `src/panels/MyPanel.tsx` exporting a component taking `PanelProps`
 *   2. `registerPanel({ id: 'changes', title: 'Changes', icon: 'file-edit', order: 20, component: MyPanel })`
 *   3. import that module below.
 * Reserved ids (the shell links to them when present): 'changes' (edit cards get an "open in Changes" action,
 * `useUi.getState().inspectorFocus` carries the file path), 'files', 'tasks', 'context', 'terminal', 'preview'.
 */
import './PlanPanel';
import './ChangesPanel';
import './FilesPanel';
import './TasksPanel';
import './ContextPanel';
import './terminal/TerminalPanel';
