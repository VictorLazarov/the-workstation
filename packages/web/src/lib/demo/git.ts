/** Stateful fake git + file contents for `?demo=1` (backs the Changes and Files panels). */
import { DEMO_CWD } from './fixtures';

const THEME_DIFF = `diff --git a/src/styles/theme.css b/src/styles/theme.css
index 3a1c2e4..9b7d0f1 100644
--- a/src/styles/theme.css
+++ b/src/styles/theme.css
@@ -1,9 +1,20 @@
 :root {
   --bg: #faf9f5;
   --fg: #1f1e1b;
-  --accent: #c15f3c;
 }
+
+:root[data-theme='dark'] {
+  --bg: #1e1d1b;
+  --fg: #ece9e1;
+}
+
+@media (prefers-color-scheme: dark) {
+  :root:not([data-theme='light']) {
+    --bg: #1e1d1b;
+    --fg: #ece9e1;
+  }
+}
 
 body {
   background: var(--bg);
`;
const SETTINGS_DIFF = `diff --git a/src/routes/settings.tsx b/src/routes/settings.tsx
index 51aa3c0..e7f2b9d 100644
--- a/src/routes/settings.tsx
+++ b/src/routes/settings.tsx
@@ -1,5 +1,7 @@
 import { useState } from 'react';
+import { ThemeToggle } from '../components/ThemeToggle';
+import { useTheme } from '../lib/useTheme';
 
 export function Settings() {
+  const [theme, setTheme] = useTheme();
   const [saved, setSaved] = useState(false);
@@ -22,7 +24,7 @@ export function Settings() {
       <section>
         <h2>Appearance</h2>
-        <p>Coming soon.</p>
+        <ThemeToggle value={theme} onChange={setTheme} />
       </section>
`;
const HOOK = `import { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'system');
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return [theme, setTheme];
}
`;
const HOOK_DIFF = `diff --git a/src/lib/useTheme.ts b/src/lib/useTheme.ts
new file mode 100644
--- /dev/null
+++ b/src/lib/useTheme.ts
@@ -0,0 +1,${HOOK.trim().split('\n').length} @@
${HOOK.trimEnd().split('\n').map((l) => '+' + l).join('\n')}
`;

interface Entry { status: { index: string; worktree: string }; diff: string }
const initial = (): Record<string, Entry> => ({
  'src/styles/theme.css': { status: { index: ' ', worktree: 'M' }, diff: THEME_DIFF },
  'src/routes/settings.tsx': { status: { index: ' ', worktree: 'M' }, diff: SETTINGS_DIFF },
  'src/lib/useTheme.ts': { status: { index: '?', worktree: '?' }, diff: HOOK_DIFF },
});
let state = initial();
let commits = 0;

const rel = (p: string) => (p.startsWith(DEMO_CWD + '/') ? p.slice(DEMO_CWD.length + 1) : p);

export function demoGitStatus() {
  return { isRepo: true, branch: 'feat/dark-mode', root: DEMO_CWD, files: Object.entries(state).map(([path, e]) => ({ path, ...e.status })) };
}
export function demoGitDiff(path?: string): string {
  if (!path) return Object.entries(state).filter(([, e]) => e.status.index !== '?').map(([, e]) => e.diff).join('');
  return state[rel(path)]?.diff ?? '';
}
export function demoGitCommit(message: unknown) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('commit message is required');
  if (!Object.keys(state).length) throw new Error('nothing to commit');
  state = {};
  commits++;
  return { ok: true, commit: `a1b2c${commits}d`, summary: '3 files changed, 31 insertions(+), 2 deletions(-)' };
}
export function demoGitRevert(path: unknown) {
  const k = rel(String(path));
  if (!state[k]) throw new Error('file has no changes');
  const untracked = state[k].status.index === '?';
  delete state[k];
  return { ok: true, action: untracked ? 'deleted' : 'restored' };
}

const FILES: Record<string, string> = {
  'src/lib/useTheme.ts': HOOK,
  'README.md': '# acme-web\n\nThe Acme storefront.\n\n## Develop\n\n```bash\nnpm install\nnpm run dev\n```\n\n- **Auth**: see `src/middleware/auth.ts`\n- **Theme**: `src/styles/theme.css`\n',
  'package.json': '{\n  "name": "acme-web",\n  "version": "1.4.0",\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest"\n  }\n}\n',
};
export function demoReadFile(path: string) {
  const content = FILES[rel(path)] ?? `// ${rel(path)}\nexport const demo = true;\n`;
  return { content, encoding: 'utf8', truncated: false, size: content.length, path };
}
