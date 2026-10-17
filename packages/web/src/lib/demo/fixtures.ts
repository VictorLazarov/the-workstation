import type { AppConfig, ModelOption, SessionSummary, SlashCommandInfo } from '@workstation/protocol';

const now = Date.now();
const min = 60_000, hr = 3_600_000, day = 86_400_000;

export const DEMO_CWD = '/home/dev/acme-web';
export const DEMO_CWD2 = '/home/dev/api-gateway';

export const demoConfig: AppConfig = {
  anthropicBaseUrl: '', hasApiKey: true, hasAuthToken: false, defaultModel: 'claude-sonnet-4-5',
  defaultEffort: 'medium', defaultPermissionMode: 'default', customModels: [],
  recentProjects: [DEMO_CWD, DEMO_CWD2, '/home/dev/docs-site'], theme: 'system',
};

export const demoModels: ModelOption[] = [
  { id: 'claude-opus-4-1', label: 'Opus 4.1', description: 'Most capable, best for complex work' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', description: 'Balanced speed and intelligence' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest, for quick tasks' },
];

export const demoCommands: SlashCommandInfo[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', argumentHint: '[instructions]' },
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'review', description: 'Review the current changes for bugs and style' },
  { name: 'init', description: 'Create a CLAUDE.md for this project' },
  { name: 'security-review', description: 'Security review of pending changes on this branch' },
  { name: 'pdf', description: 'Skill: read, merge, split and create PDF files' },
  { name: 'frontend-design', description: 'Skill: build distinctive, production-grade interfaces' },
];

export const demoFiles = [
  'src/middleware/auth.ts', 'src/middleware/session.ts', 'src/routes/login.ts', 'src/routes/settings.tsx',
  'src/components/ThemeToggle.tsx', 'src/styles/theme.css', 'src/lib/token.ts', 'tests/auth.test.ts',
  'package.json', 'README.md', 'tsconfig.json',
];

export const demoDirs: Record<string, { name: string; kind: 'dir' | 'file' }[]> = {
  '/': [{ name: 'home', kind: 'dir' }, { name: 'tmp', kind: 'dir' }],
  '/home': [{ name: 'dev', kind: 'dir' }],
  '/home/dev': [
    { name: 'acme-web', kind: 'dir' }, { name: 'api-gateway', kind: 'dir' }, { name: 'docs-site', kind: 'dir' },
    { name: 'dotfiles', kind: 'dir' }, { name: 'notes.md', kind: 'file' },
  ],
  '/home/dev/acme-web': [{ name: 'src', kind: 'dir' }, { name: 'tests', kind: 'dir' }, { name: 'package.json', kind: 'file' }, { name: 'README.md', kind: 'file' }, { name: '.gitignore', kind: 'file' }],
  '/home/dev/acme-web/src': [{ name: 'lib', kind: 'dir' }, { name: 'routes', kind: 'dir' }, { name: 'styles', kind: 'dir' }],
  '/home/dev/acme-web/src/lib': [{ name: 'token.ts', kind: 'file' }, { name: 'useTheme.ts', kind: 'file' }],
  '/home/dev/acme-web/src/routes': [{ name: 'login.ts', kind: 'file' }, { name: 'settings.tsx', kind: 'file' }],
  '/home/dev/acme-web/src/styles': [{ name: 'theme.css', kind: 'file' }],
};

/** Every session of a project checkout reports the checkout's ONE branch (the same as the demo `git status`). */
export const demoSessions: SessionSummary[] = [
  { sessionId: 'demo-live', title: 'Migrate build to Vite 6', cwd: DEMO_CWD, gitBranch: 'feat/dark-mode', lastModified: now - 20_000, live: true },
  { sessionId: 'demo-rich', title: 'Add dark mode to settings page', cwd: DEMO_CWD, gitBranch: 'feat/dark-mode', lastModified: now - 12 * min, live: false },
  { sessionId: 'demo-auth', title: 'Refactor auth middleware', cwd: DEMO_CWD, gitBranch: 'feat/dark-mode', lastModified: now - 3 * hr, live: false },
  { sessionId: 'demo-flaky', title: 'Fix flaky checkout test', cwd: DEMO_CWD, gitBranch: 'feat/dark-mode', lastModified: now - 1 * day - 2 * hr, live: false },
  { sessionId: 'demo-rate', title: 'Design token-bucket rate limiter', cwd: DEMO_CWD2, gitBranch: 'feat/rate-limit', lastModified: now - 5 * hr, live: false },
  { sessionId: 'demo-cors', title: 'Debug CORS preflight failures', cwd: DEMO_CWD2, gitBranch: 'feat/rate-limit', lastModified: now - 4 * day, live: false },
];

/* ───────── SDK-shaped history for the rich demo session ───────── */
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const user = (text: string) => ({ type: 'user', uuid: uuid(), session_id: 'demo-rich', parent_tool_use_id: null, message: { role: 'user', content: text } });
const asst = (id: string, content: unknown[]) => ({ type: 'assistant', uuid: uuid(), session_id: 'demo-rich', parent_tool_use_id: null, message: { id, role: 'assistant', content } });
const res = (tool_use_id: string, content: string, extra?: unknown, is_error = false) => ({
  type: 'user', uuid: uuid(), session_id: 'demo-rich', parent_tool_use_id: null, tool_use_result: extra,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error }] },
});

export function richHistory(): unknown[] {
  n = 0;
  return [
    user('Add a dark mode toggle to the settings page. It should persist across reloads and respect the OS preference by default.'),
    asst('m1', [
      { type: 'thinking', thinking: 'I need to see how theming works today. Check for existing CSS variables and the settings route before choosing between a class-based or attribute-based approach.' },
      { type: 'text', text: "I'll start by looking at how the app is themed today and where the settings page lives." },
      { type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'prefers-color-scheme|data-theme', path: 'src' } },
    ]),
    res('tu1', 'src/styles/theme.css:3\nsrc/components/ThemeToggle.tsx:11'),
    asst('m2', [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: `${DEMO_CWD}/src/styles/theme.css` } }]),
    res('tu2', ':root { --bg: #fff; --fg: #111; }'),
    asst('m3', [{ type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: `${DEMO_CWD}/src/routes/settings.tsx` } }]),
    res('tu3', 'export function Settings() { ... }'),
    asst('m4', [
      { type: 'text', text: "The CSS already has variables but only a light palette, and there's no toggle on the settings page. My plan:\n\n1. Add a dark palette keyed on `[data-theme=\"dark\"]` plus a `prefers-color-scheme` fallback\n2. Create a `useTheme` hook that persists the choice to `localStorage`\n3. Add the toggle to `Settings`\n4. Cover the hook with a test" },
      { type: 'tool_use', id: 'tu4', name: 'TodoWrite', input: { todos: [
        { content: 'Add dark palette to theme.css', status: 'completed', activeForm: 'Adding dark palette' },
        { content: 'Create useTheme hook with persistence', status: 'completed', activeForm: 'Creating useTheme hook' },
        { content: 'Add toggle to Settings page', status: 'in_progress', activeForm: 'Adding toggle to Settings page' },
        { content: 'Write tests for the hook', status: 'pending', activeForm: 'Writing tests' },
      ] } },
    ]),
    res('tu4', 'Todos have been modified successfully'),
    asst('m5', [{ type: 'tool_use', id: 'tu5', name: 'Edit', input: {
      file_path: `${DEMO_CWD}/src/styles/theme.css`,
      old_string: ':root {\n  --bg: #ffffff;\n  --fg: #111111;\n}\n',
      new_string: ':root {\n  --bg: #ffffff;\n  --fg: #111111;\n  color-scheme: light;\n}\n\n[data-theme="dark"] {\n  --bg: #16151a;\n  --fg: #ece9e1;\n  color-scheme: dark;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n    --bg: #16151a;\n    --fg: #ece9e1;\n  }\n}\n',
    } }]),
    res('tu5', 'The file has been updated.', { structuredPatch: [{ oldStart: 1, newStart: 1, oldLines: 4, newLines: 15, lines: [' :root {', '   --bg: #ffffff;', '   --fg: #111111;', '+  color-scheme: light;', ' }', '+', '+[data-theme="dark"] {', '+  --bg: #16151a;', '+  --fg: #ece9e1;', '+  color-scheme: dark;', '+}', '+', '+@media (prefers-color-scheme: dark) {', '+  :root:not([data-theme="light"]) {', '+    --bg: #16151a;', '+    --fg: #ece9e1;', '+  }', '+}'] }] }),
    asst('m6', [{ type: 'tool_use', id: 'tu6', name: 'Write', input: {
      file_path: `${DEMO_CWD}/src/lib/useTheme.ts`,
      content: "import { useEffect, useState } from 'react';\n\nexport type Theme = 'system' | 'light' | 'dark';\nconst KEY = 'acme.theme';\n\nexport function useTheme() {\n  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme) || 'system');\n  useEffect(() => {\n    const root = document.documentElement;\n    if (theme === 'system') root.removeAttribute('data-theme');\n    else root.dataset.theme = theme;\n    localStorage.setItem(KEY, theme);\n  }, [theme]);\n  return [theme, setTheme] as const;\n}\n",
    } }]),
    res('tu6', 'File created successfully at: src/lib/useTheme.ts'),
    asst('m7', [{ type: 'tool_use', id: 'tu7', name: 'Edit', input: {
      file_path: `${DEMO_CWD}/src/routes/settings.tsx`,
      old_string: "      <h2>Appearance</h2>\n      <p>Coming soon.</p>",
      new_string: "      <h2>Appearance</h2>\n      <ThemeToggle value={theme} onChange={setTheme} />",
    } }]),
    res('tu7', 'The file has been updated.'),
    asst('m8', [
      { type: 'text', text: 'Now let me run the type checker and the test suite to make sure nothing regressed.' },
      { type: 'tool_use', id: 'tu8', name: 'Bash', input: { command: 'npm run typecheck && npm test -- --run', description: 'Typecheck and run unit tests' } },
    ]),
    res('tu8', '> acme-web@1.4.0 typecheck\n> tsc --noEmit\n\n> acme-web@1.4.0 test\n> vitest --run\n\n ✓ src/lib/useTheme.test.ts (3 tests) 12ms\n ✓ tests/auth.test.ts (8 tests) 41ms\n ✗ tests/settings.test.tsx (1 failed | 4 passed)\n   → expected "Appearance" heading to be rendered\n\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 15 passed (16)', undefined, true),
    asst('m9', [
      { type: 'thinking', thinking: 'The failing settings test renders without the ThemeToggle import, so the heading snapshot is stale. Update the snapshot expectation rather than the component.' },
      { type: 'text', text: "Types are clean, but one settings test fails because it asserts the old placeholder copy (\"Coming soon.\"). That's expected given my change, so I'll update the test." },
    ]),
    asst('m10', [{ type: 'tool_use', id: 'tu10', name: 'Task', input: { subagent_type: 'code-reviewer', description: 'Review dark mode changes', prompt: 'Review the diff for accessibility and contrast problems.' } }]),
    { type: 'assistant', uuid: uuid(), session_id: 'demo-rich', parent_tool_use_id: 'tu10', message: { id: 'sm1', role: 'assistant', content: [{ type: 'tool_use', id: 'stu1', name: 'Bash', input: { command: 'git diff --stat', description: 'Inspect changed files' } }] } },
    { type: 'user', uuid: uuid(), session_id: 'demo-rich', parent_tool_use_id: 'tu10', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'stu1', content: ' src/lib/useTheme.ts      | 14 ++++\n src/styles/theme.css      | 11 ++++\n 2 files changed, 25 insertions(+)' }] } },
    { type: 'assistant', uuid: uuid(), session_id: 'demo-rich', parent_tool_use_id: 'tu10', message: { id: 'sm2', role: 'assistant', content: [{ type: 'tool_use', id: 'stu2', name: 'Read', input: { file_path: `${DEMO_CWD}/src/styles/theme.css` } }] } },
    { type: 'user', uuid: uuid(), session_id: 'demo-rich', parent_tool_use_id: 'tu10', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'stu2', content: '(contents)' }] } },
    res('tu10', 'Contrast ratios pass WCAG AA (fg/bg 14.2:1). One suggestion: `color-scheme` is set, so native form controls will match.'),
    asst('m11', [{ type: 'text', text: "The review looks good. Here's what changed:\n\n| File | Change |\n| --- | --- |\n| `src/styles/theme.css` | Dark palette + OS preference fallback |\n| `src/lib/useTheme.ts` | New hook, persists to `localStorage` |\n| `src/routes/settings.tsx` | Appearance section with the toggle |\n\nThe hook is intentionally tiny:\n\n```ts\nconst [theme, setTheme] = useTheme();\n// 'system' | 'light' | 'dark'\n```\n\nOnce you've looked at it, I can add a visual regression test for both themes." }]),
    user('Looks great. Can you also make sure the toggle is keyboard accessible?'),
    asst('m12', [{ type: 'text', text: 'Yes. I will use a native radio group so arrow keys and focus rings work out of the box, rather than a custom switch.' }]),
  ];
}
