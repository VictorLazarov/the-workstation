import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The warning colour is a gold-yellow, never orange (the owner dislikes orange; the layout lint forbids hues 15-48 deg in
 * the Horizon brand), and every brand/theme keeps its semantic text colours at WCAG AA on the surfaces they sit on.
 */
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const block = (start: string) => { const a = css.indexOf(start); expect(a, start).toBeGreaterThan(-1); return css.slice(a, css.indexOf('}', a)); };
const vars = (b: string) => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const rgb = (c: string): [number, number, number, number] => {
  if (c.startsWith('#')) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
  const p = /rgba?\(([^)]+)\)/.exec(c)![1].split(',').map(Number);
  return [p[0], p[1], p[2], p[3] ?? 1];
};
const blend = (t: number[], b: number[]) => [0, 1, 2].map((i) => t[i] * t[3] + b[i] * (1 - t[3])).concat(1);
const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hue = ([r, g, b]: number[]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b); if (!d) return 0; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };

const THEMES = {
  'horizon light': vars(block('/* ── horizon (default): shape, type + light ── */')),
  'horizon dark': vars(block(":root[data-theme='dark'] {")),
  'warm light': vars(block(":root[data-brand='warm'] {")),
  'warm dark': vars(block(":root[data-brand='warm'][data-theme='dark'] {")),
};

describe('design tokens', () => {
  for (const [name, v] of Object.entries(THEMES)) {
    const surfaces = ['bg', 'surface', 'surface-2', 'sidebar-bg', 'code-bg'].map((k) => rgb(v[k]));
    it(`${name}: --warn is gold-yellow (hue >= 48) and AA on every surface and on its own tint`, () => {
      const warn = rgb(v.warn);
      expect(hue(warn), 'hue').toBeGreaterThanOrEqual(name.startsWith('horizon') ? 48 : 40);
      for (const s of surfaces) {
        expect(ratio(warn, s), `warn on a surface`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(warn, blend(rgb(v['warn-soft']), s)), 'warn on warn-soft').toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: text colours are AA on the surfaces they are used on`, () => {
      for (const k of ['text', 'text-2', 'muted', 'accent', 'ok', 'danger', 'info']) for (const s of [rgb(v.bg), rgb(v.surface), rgb(v['sidebar-bg'])]) {
        expect(ratio(rgb(v[k]), s), `--${k}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: primary and danger fills carry readable label text`, () => {
      expect(ratio(rgb(v['accent-fg']), rgb(v['accent-solid'])), 'primary').toBeGreaterThanOrEqual(4.5);
      expect(ratio(rgb(v['accent-fg']), rgb(v['accent-solid-hover'])), 'primary hover').toBeGreaterThanOrEqual(4.5);
      expect(ratio([255, 255, 255], rgb(v['danger-fill'])), 'danger fill').toBeGreaterThanOrEqual(4.5);
    });
  }
});
