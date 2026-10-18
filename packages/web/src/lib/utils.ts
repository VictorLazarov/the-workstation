export function uid(prefix = ''): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + r;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.round(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(d / 365)}y`;
}

/** True for `C:\x`, `C:/x` and UNC `\\host\share` paths (a Windows server). */
export const isWinPath = (p: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith('\\\\');
/** Windows paths use `/` internally in the UI (the server accepts both); POSIX paths are untouched (`\` is a legal file-name char there). */
export const normPath = (p: string): string => (isWinPath(p) ? p.replace(/\\/g, '/') : p);
/** Drive root (`C:/`) or `/`. */
export const isRootPath = (p: string): boolean => p === '/' || /^[A-Za-z]:\/?$/.test(p);

export function basename(p: string): string {
  const t = normPath(p).replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) || t : t;
}
export function dirname(p: string): string {
  const t = normPath(p).replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(t)) return `${t}/`; // a drive root is its own parent
  const i = t.lastIndexOf('/');
  if (i === 2 && /^[A-Za-z]:\//.test(t)) return t.slice(0, 3); // C:/x -> C:/
  return i > 0 ? t.slice(0, i) : i === 0 ? '/' : '';
}

/** Path relative to cwd when inside it, else with ~ shortening of home-like prefixes. */
export function relPath(p: string, cwd?: string): string {
  const np = normPath(p);
  const base = cwd ? normPath(cwd).replace(/\/+$/, '') : '';
  // drive letters are case-insensitive on Windows
  const win = isWinPath(np);
  const lower = (x: string) => (win ? x.toLowerCase() : x);
  if (base && lower(np).startsWith(lower(base) + '/')) return np.slice(base.length + 1);
  return np.replace(/^\/(?:home|Users)\/[^/]+/, '~').replace(/^[A-Za-z]:\/Users\/[^/]+/, '~');
}

/** Ends in an ellipsis already (the SDK / a session title shortened it before us). */
const TRAILING_ELLIPSIS = /(?:\.{2,}|…)+$/;
/** Shortens to at most `n` characters with exactly ONE trailing ellipsis (never "……" or "..." + "…"). */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd().replace(TRAILING_ELLIPSIS, '') + '…';
}

export function formatCost(usd: number): string {
  if (!usd) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(usd < 1 ? 3 : 2).replace(/0$/, '');
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function contextWindowFor(model?: string): number {
  if (!model) return 200_000;
  return /\[1m\]|-1m\b/i.test(model) ? 1_000_000 : 200_000;
}

/** Friendly model name: claude-sonnet-4-5-20250929 -> Sonnet 4.5 */
export function modelLabel(id?: string): string {
  if (!id || id === 'default') return 'Default model';
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/i.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? '.' + m[3] : ''}`;
  const m2 = /claude-(\d+)(?:[-.](\d+))?-(opus|sonnet|haiku)/i.exec(id);
  if (m2) return `${m2[3][0].toUpperCase()}${m2[3].slice(1)} ${m2[1]}${m2[2] ? '.' + m2[2] : ''}`;
  return id.replace(/\[1m\]/, ' (1M)');
}

/** Cheap subsequence fuzzy score (higher is better, -1 = no match). */
export function fuzzy(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase(), t = text.toLowerCase();
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return -1;
    streak = f === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - Math.min(f - ti, 5) * 0.2 + (f === 0 || /[\s/_.-]/.test(t[f - 1]) ? 2 : 0);
    ti = f + 1;
  }
  return score - t.length * 0.01;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let h: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(h);
  return d;
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/** Only http(s) URLs may become links (model/tool input can carry javascript:, data:, file: …). */
export function isHttpUrl(u: string): boolean {
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

export function groupBy<T>(xs: T[], key: (x: T) => string): Record<string, T[]> {
  const o: Record<string, T[]> = {};
  for (const x of xs) (o[key(x)] ??= []).push(x);
  return o;
}
