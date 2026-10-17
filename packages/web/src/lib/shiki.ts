/** Lazy shiki: core + JS regex engine, languages loaded on demand (each its own chunk). */
import type { HighlighterCore } from 'shiki/core';

const langLoaders: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
};
const alias: Record<string, string> = {
  ts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  py: 'python', yml: 'yaml', md: 'markdown', rs: 'rust', 'c++': 'cpp', htm: 'html', jsonc: 'json', json5: 'json', rb: 'ruby',
};

export function resolveLang(lang?: string): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const r = alias[l] ?? l;
  return langLoaders[r] ? r : null;
}

export function langFromPath(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  if (!m) return /(^|\/)Dockerfile$/.test(path) ? 'dockerfile' : null;
  return resolveLang(m[1]);
}

/** Horizon has no orange: swap the stock GitHub themes' orange/amber token colours for teal/blue/violet equivalents. */
const LIGHT_SWAPS: Record<string, string> = { '#e36209': '#17707a', '#b08800': '#6f42c1', '#dbab09': '#6f42c1', '#ffdf5d': '#dbedff', '#ffd33d': '#dbedff', '#f9c513': '#dbedff', '#ffebda': '#ebf8ff' };
const DARK_SWAPS: Record<string, string> = { '#e0823d': '#56d4dd', '#f69d50': '#76e3ea', '#cc6b2c': '#39c5cf', '#682d0f': '#0d3b40', '#c69026': '#96d0ff', '#ae7c14': '#6cb6ff', '#eac55f': '#96d0ff', '#daaa3f': '#96d0ff', '#966600': '#316dca' };
function noOrange<T extends object>(theme: T, swaps: Record<string, string>): T {
  return JSON.parse(JSON.stringify(theme).replace(/#[0-9a-fA-F]{6}\b/g, (c) => swaps[c.toLowerCase()] ?? c));
}

let hl: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

async function getHl(): Promise<HighlighterCore> {
  hl ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    return createHighlighterCore({
      themes: [
        import('shiki/themes/github-light.mjs').then((m) => noOrange(m.default, LIGHT_SWAPS)),
        import('shiki/themes/github-dark-dimmed.mjs').then((m) => noOrange(m.default, DARK_SWAPS)),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return hl;
}

const cache = new Map<string, string>();

/**
 * Returns highlighted HTML (dual-theme via CSS vars) or null if the language is unsupported.
 * SECURITY: this (escaped Shiki output) is the ONLY value allowed into dangerouslySetInnerHTML; on null, callers render
 * plain text. Never add a raw-HTML fallback here (pinned by lib/html-sinks.test.ts).
 */
export async function highlight(code: string, lang?: string | null): Promise<string | null> {
  const l = resolveLang(lang ?? undefined);
  if (!l) return null;
  const key = l + '\0' + code;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const h = await getHl();
    if (!loaded.has(l)) {
      const mod = (await langLoaders[l]()) as { default: never };
      await h.loadLanguage(mod.default);
      loaded.add(l);
    }
    const html = h.codeToHtml(code, { lang: l, themes: { light: 'github-light', dark: 'github-dark-dimmed' }, defaultColor: false });
    if (cache.size > 300) cache.clear();
    cache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

/** Highlight into per-line HTML strings (for diffs / file views). */
export async function highlightLines(code: string, lang?: string | null): Promise<string[] | null> {
  const html = await highlight(code, lang);
  if (!html) return null;
  const m = html.match(/<span class="line">[\s\S]*?<\/span>(?=\n<span class="line">|<\/code>)/g);
  return m ? m.map((s) => s.replace(/^<span class="line">/, '').replace(/<\/span>$/, '')) : null;
}
