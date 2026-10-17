/**
 * Supported browsers, single source of truth: `browserslist` in package.json (also read by eslint-plugin-compat / caniuse tooling).
 * Safari 16.4+ (lookbehind regex, @property, container queries, color-mix), Firefox 115 ESR, Chrome 111+ (Chrome 110 lacks
 * `color-mix()`, which the theme uses throughout, so the floor is 111 rather than 110).
 * Consumed by vite.config.ts (build.target) and src/lib/compat.test.ts (feature floors).
 */
import pkg from './package.json';

export type Engine = 'chrome' | 'firefox' | 'safari';

function parse(list: string[]): Record<Engine, number> {
  const out = {} as Record<Engine, number>;
  for (const q of list) {
    const m = /^(chrome|firefox|safari) >= ([\d.]+)$/.exec(q.trim());
    if (!m) throw new Error(`unsupported browserslist query "${q}" (expected "<chrome|firefox|safari> >= <version>")`);
    out[m[1] as Engine] = Number(m[2]);
  }
  for (const e of ['chrome', 'firefox', 'safari'] as const) if (!out[e]) throw new Error(`browserslist is missing ${e}`);
  return out;
}

export const browserFloors: Record<Engine, number> = parse((pkg as { browserslist: string[] }).browserslist);
/** esbuild targets, e.g. ['chrome111', 'firefox115', 'safari16.4'] */
export const buildTargets: string[] = (Object.entries(browserFloors) as Array<[Engine, number]>).map(([e, v]) => `${e}${v}`);
