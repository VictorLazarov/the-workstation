/**
 * Browser-support gate (no real Firefox/WebKit needed): scans the SOURCE (css, ts, tsx) and, when `npm run build` has run,
 * the BUILT bundle for features newer than the supported floor in package.json `browserslist` (Safari 16.4, Firefox 115,
 * Chrome 111; see browser-targets.ts). A feature is either supported by every floor, or listed as `graceful` (pure
 * progressive enhancement: the page works and looks right without it), or must come with its fallback.
 *
 * To use a newer API/CSS feature: add a fallback/polyfill and list it here as graceful, or raise the floor deliberately.
 */
import fs from 'node:fs';
import path from 'node:path';
import { transformWithEsbuild } from 'vite'; // vite's own esbuild: no extra dependency
import { describe, expect, it } from 'vitest';
import { browserFloors, buildTargets, type Engine } from '../../browser-targets';

/** esbuild cannot lower the RegExp `v` flag: it rewrites the literal to `new RegExp("pattern", "v")`, which throws on older engines. */
const V_FLAG_REGEXP = /new RegExp\(\s*("[^"]+"|'[^']+'|`[^`]+`)\s*,\s*["'][dgimsuy]*v[dgimsuy]*["']\s*\)/;

const SRC = path.resolve(__dirname, '..');
const DIST = path.resolve(__dirname, '../../dist');

type Support = Record<Engine, number | null>; // first version with support; null = not supported (yet)
interface Feature { name: string; re: RegExp; since: Support; kind: 'css' | 'js'; graceful?: string }
const f = (name: string, kind: 'css' | 'js', re: RegExp, c: number | null, ff: number | null, s: number | null, graceful?: string): Feature => ({ name, kind, re, since: { chrome: c, firefox: ff, safari: s }, graceful });

/** Features NEWER than the floors (anything older than every floor needs no entry). */
export const FEATURES: Feature[] = [
  // CSS
  f(':has()', 'css', /:has\(/, 105, 121, 15.4),
  f('light-dark()', 'css', /light-dark\(/, 123, 120, 17.5),
  f('@scope', 'css', /@scope\b/, 118, 128, 17.4),
  f('subgrid', 'css', /subgrid/, 117, 71, 16),
  f('anchor positioning', 'css', /anchor-name|position-anchor|anchor\(/, 125, null, null),
  f('@property', 'css', /@property\b/, 85, 128, 16.4),
  f(':user-valid/:user-invalid', 'css', /:user-(in)?valid/, 119, 88, 16.5),
  f('interpolate-size / calc-size()', 'css', /interpolate-size|calc-size\(/, 129, null, null),
  f('scrollbar-gutter', 'css', /scrollbar-gutter/, 94, 97, 18.2, 'layout shift only'),
  f('scrollbar-width', 'css', /scrollbar-width/, 121, 64, 18.2, 'paired with ::-webkit-scrollbar rules'),
  f('scrollbar-color', 'css', /scrollbar-color/, 121, 64, 18.2, 'Firefox-only @supports block'),
  f('field-sizing', 'css', /field-sizing/, 123, null, null, 'textarea auto-grow also done in JS'),
  f('text-wrap balance/pretty', 'css', /text-wrap\s*:\s*(balance|pretty)/, 114, 121, 17.5, 'typographic nicety'),
  f('@starting-style', 'css', /@starting-style/, 117, 129, 17.5, 'entry animation only'),
  f('content-visibility', 'css', /content-visibility/, 85, 125, 18, 'perf hint only'),
  f('view transitions', 'css', /view-transition/, 111, 144, 18, 'animation only'),
  // JS APIs
  f('Array.fromAsync', 'js', /Array\.fromAsync/, 121, 115, 16.4),
  f('Promise.withResolvers', 'js', /Promise\.withResolvers/, 119, 121, 17.4),
  f('Object/Map.groupBy', 'js', /(Object|Map)\.groupBy\(/, 117, 119, 17.4),
  f('Intl.Segmenter', 'js', /Intl\.Segmenter/, 87, 125, 14.1),
  f('requestIdleCallback (not in Safari)', 'js', /(request|cancel)IdleCallback/, 47, 55, null),
  f('AbortSignal.any', 'js', /AbortSignal\.any\(/, 116, 124, 17.4),
  f('String isWellFormed/toWellFormed', 'js', /\.(isWellFormed|toWellFormed)\(/, 111, 119, 16.4),
  f('Set methods (union, intersection, ...)', 'js', /\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, 122, 127, 17),
  f('Popover API', 'js', /showPopover\(|\bpopover=|\bpopovertarget/, 114, 125, 17),
  f('navigator.userAgentData', 'js', /navigator\.userAgentData/, 90, null, null),
  f('Iterator helpers', 'js', /Iterator\.from\(|\.values\(\)\.(map|filter|take|drop|toArray)\(/, 122, 131, 18.4),
  f('Temporal', 'js', /\bTemporal\./, null, 139, null),
];

const exceeds = (since: Support): Engine[] => (Object.keys(browserFloors) as Engine[]).filter((e) => since[e] === null || since[e]! > browserFloors[e]);

function walk(dir: string, ext: RegExp, skip: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, ext, skip) : ext.test(e.name) && !skip.test(e.name) ? [p] : [];
  });
}
/** Strip comments/strings crudely enough to avoid matching prose in docs (`/* ... *\/`, `// ...`). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const cssFiles = walk(SRC, /\.css$/, /^$/);
const jsFiles = walk(SRC, /\.(ts|tsx)$/, /\.test\.tsx?$|compat\.ts$/);

describe('supported-browser floors', () => {
  it('browserslist is the single source for the Vite build target', () => {
    expect(browserFloors).toEqual({ chrome: 111, firefox: 115, safari: 16.4 });
    expect(buildTargets).toEqual(['chrome111', 'firefox115', 'safari16.4']);
  });

  for (const kind of ['css', 'js'] as const) {
    it(`source ${kind}: no feature newer than the floors unless it is progressive enhancement`, () => {
      const problems: string[] = [];
      for (const file of kind === 'css' ? cssFiles : jsFiles) {
        const text = stripComments(fs.readFileSync(file, 'utf8'));
        for (const ft of FEATURES.filter((x) => x.kind === kind)) {
          if (!ft.re.test(text)) continue;
          const bad = exceeds(ft.since);
          if (bad.length && !ft.graceful) problems.push(`${path.relative(SRC, file)}: ${ft.name} needs a newer ${bad.join('/')} than the floor`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('CSS fallbacks that browsers still require are present', () => {
    const all = cssFiles.map((p) => stripComments(fs.readFileSync(p, 'utf8'))).join('\n');
    // Safari (all versions so far) only knows the prefixed user-select; Safari < 18 the prefixed backdrop-filter; Chrome < 120 prefixed mask-image
    for (const prop of ['user-select', 'backdrop-filter', 'mask-image']) {
      const plain = [...all.matchAll(new RegExp(`(?<![-\\w])${prop}\\s*:`, 'g'))].length;
      const prefixed = [...all.matchAll(new RegExp(`-webkit-${prop}\\s*:`, 'g'))].length;
      expect(prefixed, `${prop}: every use needs a -webkit- twin`).toBeGreaterThanOrEqual(plain);
    }
    // hiding scrollbars with the standard property is ignored by Safari < 18.2: needs the WebKit pseudo-element too
    if (/scrollbar-width\s*:\s*none/.test(all)) expect(all).toMatch(/::-webkit-scrollbar\s*\{\s*display:\s*none/);
  });

  it('Safari/Firefox-sensitive runtime guards exist', () => {
    const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
    // Notification / clipboard are missing or restricted (insecure origins, Safari): guarded or falling back
    expect(read('platform/index.ts')).toMatch(/typeof Notification === 'undefined'/);
    expect(read('platform/index.ts')).toMatch(/execCommand\('copy'\)/);
    // WebSockets die in Safari/Firefox back-forward cache: the transport reconnects on pageshow/visibility
    expect(read('lib/transport/ws.ts')).toMatch(/pageshow/);
    expect(read('lib/transport/ws.ts')).toMatch(/visibilitychange/);
    // ResizeObserver callbacks that change layout are deferred to a frame (no "loop completed with undelivered notifications")
    expect(read('panels/terminal/TermView.tsx')).toMatch(/ResizeObserver\(\(\) => requestAnimationFrame/);
    // Shiki runs on the JS regex engine (no WebAssembly: the CSP has no 'wasm-unsafe-eval')
    expect(read('lib/shiki.ts')).toMatch(/createJavaScriptRegexEngine/);
    expect(read('lib/shiki.ts')).not.toMatch(/shiki\/wasm|oniguruma/);
  });
});

describe('the gate itself catches violations', () => {
  const hit = (name: string, sample: string) => expect(FEATURES.find((x) => x.name === name)!.re.test(sample), name).toBe(true);
  it('feature detectors match real-world spellings', () => {
    hit(':has()', '.a:has(> .b) { }'); hit('Promise.withResolvers', 'const { promise } = Promise.withResolvers();'); hit('requestIdleCallback (not in Safari)', 'window.requestIdleCallback(fn)');
    hit('Intl.Segmenter', 'new Intl.Segmenter("en")'); hit('Object/Map.groupBy', 'Object.groupBy(xs, f)'); hit('Set methods (union, intersection, ...)', 'a.union(b)');
  });
  it('a regex `v` flag (Safari 17 / Firefox 116) is detected even after esbuild rewrites it to new RegExp(..., "v")', async () => {
    const r = await transformWithEsbuild('export const re = /[\\p{L}--[a-z]]/v;', 'x.js', { target: buildTargets, loader: 'js', logLevel: 'silent', format: 'esm' });
    expect(V_FLAG_REGEXP.test(r.code)).toBe(true);
    expect(V_FLAG_REGEXP.test('new RegExp("","v")')).toBe(false); // shiki's own feature probe (try/catch) has an empty pattern
  });
});

describe.skipIf(!fs.existsSync(path.join(DIST, 'index.html')))('built bundle (run after `npm run build`)', () => {
  const assets = fs.existsSync(path.join(DIST, 'assets')) ? fs.readdirSync(path.join(DIST, 'assets')) : [];

  it('every JS chunk is valid for the floors: esbuild reports nothing it cannot lower', async () => {
    const offenders: string[] = [];
    for (const a of assets.filter((n) => n.endsWith('.js'))) {
      const code = fs.readFileSync(path.join(DIST, 'assets', a), 'utf8');
      const r = await transformWithEsbuild(code, a, { target: buildTargets, loader: 'js', logLevel: 'silent', format: 'esm' });
      for (const w of r.warnings) if (/target environment|not (available|supported)/i.test(w.text)) offenders.push(`${a}: ${w.text}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no non-empty regex with the `v` flag in any chunk (it would throw at load on Safari < 17 / Firefox < 116)', () => {
    const bad = assets.filter((n) => n.endsWith('.js')).filter((a) => V_FLAG_REGEXP.test(fs.readFileSync(path.join(DIST, 'assets', a), 'utf8')));
    expect(bad).toEqual([]);
  });

  it('built CSS has no feature newer than the floors', () => {
    const problems: string[] = [];
    for (const a of assets.filter((n) => n.endsWith('.css'))) {
      const css = fs.readFileSync(path.join(DIST, 'assets', a), 'utf8');
      for (const ft of FEATURES.filter((x) => x.kind === 'css')) if (ft.re.test(css) && exceeds(ft.since).length && !ft.graceful) problems.push(`${a}: ${ft.name}`);
    }
    expect(problems).toEqual([]);
  });

  it('index.html needs no inline script beyond the hashed theme bootstrap (CSP: script-src self + hashes)', () => {
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    expect([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)]).toHaveLength(1);
    expect(html).not.toMatch(/\son[a-z]+=/i); // no inline event handlers
  });
});
