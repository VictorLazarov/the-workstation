/** Build an xterm theme from the app's CSS tokens so the terminal follows light/dark. */
export function readTermTheme(): Record<string, string> {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  const dark = cs.colorScheme.includes('dark');
  const base = dark
    ? { black: '#3b3a37', red: '#ea6a58', green: '#5cb97f', yellow: '#e0a83a', blue: '#6a9be0', magenta: '#c58bd8', cyan: '#5fbfc4', white: '#c2beb2',
        brightBlack: '#6f6b60', brightRed: '#f08a7b', brightGreen: '#7fcf9a', brightYellow: '#ecc064', brightBlue: '#8bb3ec', brightMagenta: '#d6a6e6', brightCyan: '#83d3d7', brightWhite: '#ece9e1' }
    : { black: '#1f1e1b', red: '#c8412f', green: '#3d8b5a', yellow: '#a8741a', blue: '#3b6fb6', magenta: '#9a4fb0', cyan: '#2a8a90', white: '#8f8b7f',
        brightBlack: '#55524a', brightRed: '#d9604f', brightGreen: '#52a671', brightYellow: '#c0861a', brightBlue: '#5a8bd0', brightMagenta: '#b36bc8', brightCyan: '#3fa3a9', brightWhite: '#55524a' };
  return {
    ...base,
    background: v('--code-bg', dark ? '#242321' : '#f4f2ea'),
    foreground: v('--text', dark ? '#ece9e1' : '#1f1e1b'),
    cursor: v('--accent', '#c15f3c'),
    cursorAccent: v('--code-bg', '#ffffff'),
    selectionBackground: dark ? 'rgba(217,119,87,0.35)' : 'rgba(193,95,60,0.25)',
  };
}

/** Calls cb when the theme (data-theme attr or OS scheme) changes. */
export function onThemeChange(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  return () => { mo.disconnect(); mq.removeEventListener('change', cb); };
}
