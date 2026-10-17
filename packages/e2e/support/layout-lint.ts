// @ts-nocheck -- lintInPage runs inside the browser (serialised by page.evaluate) and is deliberately dynamic.
import type { Page } from '@playwright/test';

/**
 * layout-lint.ts: programmatic visual/a11y lint for The Workstation web UI (originated in scrutiniser pass 2).
 *
 *   import { lintPage, formatIssues } from '../support/layout-lint.ts';
 *   const issues = await lintPage(page, { brand: 'horizon' });
 *   expect(errorsOf(issues), formatIssues(issues)).toEqual([]);
 *
 * Checks (every check returns {rule, severity, sel, msg}):
 *   overlap          visible in-flow siblings whose boxes intersect (> 4px²)
 *   touching         interactive elements stacked/adjacent with < 1px gap (rows that touch each other)
 *   page-overflow    document scrolls horizontally
 *   h-scroll         element shows a horizontal scrollbar (overflow-x auto/scroll and content wider) — warn
 *   clipped          text cut off by overflow:hidden with no ellipsis
 *   truncated-no-tip text truncated with ellipsis but no title/aria-label anywhere up the tree
 *   small-target     interactive element smaller than 24x24 CSS px (WCAG 2.5.8), unless inline in text
 *   contrast         text contrast below AA (4.5:1, 3:1 for large text) against the resolved background
 *   forbidden-hue    (horizon only) orange-ish colour: hue 15–48°, saturation > 0.5, alpha > 0.15
 *   no-name          button/link/[role=button] with no accessible name
 *   img-alt          <img> without alt
 *   offscreen        interactive element partially outside the viewport horizontally (clipped by window)
 *   spill            nowrap text wider than its (overflow:visible) box, i.e. painting over its neighbours
 */

/** Runs in the page. Kept dependency-free so it can be passed to page.evaluate. */
function lintInPage(opts: { brand: string }) {
  const issues = [];
  const add = (rule, severity, el, msg) => issues.push({ rule, severity, sel: path(el), msg });
  const vw = window.innerWidth, vh = window.innerHeight;

  function path(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let e = el;
    for (let i = 0; e && e.nodeType === 1 && i < 5; i++) {
      let s = e.tagName.toLowerCase();
      if (e.id) { s += '#' + e.id; parts.unshift(s); break; }
      const cls = [...e.classList].filter((c) => !/^(on|open|sel|active)$/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      const al = e.getAttribute('aria-label');
      if (al) s += `[aria-label="${al.slice(0, 30)}"]`;
      parts.unshift(s);
      e = e.parentElement;
    }
    const txt = (el.innerText || el.getAttribute?.('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return parts.join(' > ') + (txt ? `  «${txt}»` : '');
  }

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
    // inside a clipped scroller? check the nearest overflow ancestor
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ps = getComputedStyle(p);
      if (ps.overflow !== 'visible' || ps.overflowX !== 'visible' || ps.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        if (r.bottom <= pr.top || r.top >= pr.bottom || r.right <= pr.left || r.left >= pr.right) return false;
      }
      if (ps.display === 'none' || ps.visibility === 'hidden' || Number(ps.opacity) === 0) return false;
      p = p.parentElement;
    }
    return true;
  }
  // topmost-layer filter: if a modal is open, only lint inside it (plus fixed toasts)
  const modal = [...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]')].filter(visible).pop();
  const inScope = (el) => !modal || modal.contains(el) || el.closest('.toasts');

  const all = [...document.body.querySelectorAll('*')].filter((e) => !(e instanceof SVGElement && e.tagName !== 'svg'));
  const vis = all.filter((e) => inScope(e) && visible(e));
  const visSet = new Set(vis);

  // ---------- colour helpers ----------
  const ctx = document.createElement('canvas').getContext('2d');
  function parse(c) {
    if (!c || c === 'transparent') return null;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    // color(srgb ...) / oklch etc: let canvas normalize
    ctx.fillStyle = '#000'; ctx.fillStyle = c; const n = ctx.fillStyle;
    if (n.startsWith('#')) { const h = n.slice(1); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }; }
    const m2 = n.match(/rgba?\(([^)]+)\)/); if (m2) { const p = m2[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    return null;
  }
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function hsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2;
    if (mx === mn) return { h: 0, s: 0, l }; const d = mx - mn; const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: h * 60, s, l };
  }
  function bgOf(el) {
    // returns {color, unknown}: walks up, blending translucent backgrounds; gradients/images mark unknown
    const stack = []; let e = el; let unknown = false;
    while (e && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('url(')) unknown = true;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
      e = e.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    if (!stack.length || stack[stack.length - 1].a < 1) { const bc = parse(getComputedStyle(document.body).backgroundColor); if (bc && bc.a) base = bc; }
    for (let i = stack.length - 1; i >= 0; i--) base = stack[i].a >= 1 ? stack[i] : blend(stack[i], base);
    return { color: base, unknown };
  }
  const effOpacity = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };

  // ---------- per element ----------
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=option], [role=switch], [role=menuitem], [role=checkbox], [role=radio], summary';
  const interactive = vis.filter((e) => e.matches(INTERACTIVE) && !e.closest('[aria-hidden=true]'));

  for (const el of vis) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);

    // contrast
    if (ownText && !el.closest('[disabled],[aria-disabled=true],.cm-editor,.xterm,.shiki,pre code') && !el.matches('option')) {
      const fg = parse(cs.color);
      if (fg) {
        const { color: bg, unknown } = bgOf(el);
        const op = effOpacity(el);
        const fgEff = blend({ ...fg, a: (fg.a ?? 1) * op }, bg);
        const cr = ratio(fgEff, bg);
        const size = parseFloat(cs.fontSize);
        const bold = Number(cs.fontWeight) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const need = large ? 3 : 4.5;
        if (size >= 1 && cr < need - 0.05) add('contrast', unknown ? 'warn' : 'error', el, `${cr.toFixed(2)}:1 < ${need} (fg ${cs.color}${op < 1 ? ' @op' + op.toFixed(2) : ''} on rgb(${bg.r | 0},${bg.g | 0},${bg.b | 0})${unknown ? ', gradient bg' : ''}, ${size}px)`);
      }
    }

    // forbidden hue
    if (opts.brand === 'horizon') {
      const props = ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'borderBottomColor', 'outlineColor', 'fill', 'stroke'];
      for (const p of props) {
        if (p.startsWith('border') && parseFloat(cs[p.replace('Color', 'Width')]) === 0) continue;
        if (p === 'outlineColor' && (cs.outlineStyle === 'none' || parseFloat(cs.outlineWidth) === 0)) continue;
        if (p === 'color' && !ownText && !(el instanceof SVGElement)) continue;
        const c = parse(cs[p]); if (!c || c.a < 0.15) continue;
        const h = hsl(c);
        if (h.h >= 15 && h.h <= 48 && h.s > 0.5 && h.l > 0.12 && h.l < 0.92) { add('forbidden-hue', 'error', el, `${p} ${cs[p]} (h${h.h.toFixed(0)} s${h.s.toFixed(2)} l${h.l.toFixed(2)})`); break; }
      }
      for (const img of [cs.backgroundImage, cs.boxShadow]) {
        if (!img || img === 'none') continue;
        for (const m of img.match(/rgba?\([^)]+\)/g) ?? []) {
          const c = parse(m); if (!c || c.a < 0.15) continue; const h = hsl(c);
          if (h.h >= 15 && h.h <= 48 && h.s > 0.5 && h.l > 0.12 && h.l < 0.92) { add('forbidden-hue', 'error', el, `gradient/shadow ${m}`); break; }
        }
      }
    }

    // clipped text / truncated without tooltip
    const clips = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden';
    if (clips && el.scrollWidth > el.clientWidth + 1 && (el.innerText || '').trim() && !el.matches('textarea,input,.sr-only') && r.width > 2) {
      const hasTip = !!el.closest('[title]') || !!el.closest('[aria-label]') || !!el.closest('[data-tip]');
      if (cs.textOverflow !== 'ellipsis' && !el.querySelector('[style*=ellipsis]')) {
        // only report when it is a text container (not a scroll viewport for panels)
        if (cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') add('clipped', 'error', el, `text clipped without ellipsis (${el.scrollWidth}>${el.clientWidth})`);
      } else if (!hasTip) add('truncated-no-tip', 'warn', el, `ellipsis but no title/tooltip (${el.scrollWidth}>${el.clientWidth})`);
    }
    if (clips && el.scrollHeight > el.clientHeight + 2 && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll' && cs.webkitLineClamp === 'none' && (el.innerText || '').trim() && r.height < 60 && cs.whiteSpace !== 'nowrap') {
      add('clipped', 'warn', el, `text clipped vertically (${el.scrollHeight}>${el.clientHeight})`);
    }

    // text spilling out of its own box (overflow visible + nowrap): renders on top of the next sibling
    if (!clips && cs.overflowX === 'visible' && (cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && ownText && cs.display !== 'inline') {
      add('spill', 'error', el, `text spills out of its box (${el.scrollWidth}>${el.clientWidth}) and may overlap neighbours`);
    }
    // horizontal scrollbars
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !el.matches('pre, .shiki, .xterm-viewport, .diff, textarea') && !el.closest('pre,.diff,.xterm')) {
      add('h-scroll', 'warn', el, `horizontal scrollbar (${el.scrollWidth}>${el.clientWidth})`);
    }

    if (el.tagName === 'IMG' && !el.hasAttribute('alt')) add('img-alt', 'error', el, 'img without alt');
  }

  // page overflow
  const se = document.scrollingElement;
  if (se.scrollWidth > se.clientWidth + 1) add('page-overflow', 'error', document.body, `page scrolls horizontally (${se.scrollWidth}>${se.clientWidth})`);
  for (const el of [document.querySelector('.app'), document.querySelector('.shell')]) if (el && el.scrollWidth > el.clientWidth + 1) add('page-overflow', 'error', el, `shell wider than viewport (${el.scrollWidth}>${el.clientWidth})`);

  // interactive checks
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    // accessible name
    const name = (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.innerText) || (el.innerText || '').trim() || el.getAttribute('title') || (el.labels && el.labels[0]?.innerText) || el.getAttribute('placeholder') || (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type) && el.value);
    if (!name) add('no-name', 'error', el, 'interactive element without accessible name');
    else if (!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.innerText || '').trim() || (el.labels && el.labels.length)) && el.getAttribute('title')) add('no-name', 'warn', el, 'name only from title attribute');
    // hit target
    const inline = getComputedStyle(el).display === 'inline' || (el.tagName === 'A' && el.closest('p,li,td'));
    if (!inline && (r.width < 24 || r.height < 24) && !el.matches('input[type=checkbox],input[type=radio]')) {
      add('small-target', r.width < 20 || r.height < 20 ? 'error' : 'warn', el, `${r.width.toFixed(0)}x${r.height.toFixed(0)}px`);
    }
    if (r.left < -1 || r.right > vw + 1) add('offscreen', 'error', el, `extends outside viewport (${r.left.toFixed(0)}..${r.right.toFixed(0)} of ${vw})`);
  }

  // touching interactive elements (stack axis gap < 1px), only those with a visible hover/selected surface
  function clipRect(el) {
    const r = el.getBoundingClientRect(); let L = r.left, T = r.top, R = r.right, B = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX !== 'visible' || ps.overflowY !== 'visible') { const q = p.getBoundingClientRect(); L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom); }
    }
    return { left: L, top: T, right: R, bottom: B, width: Math.max(0, R - L), height: Math.max(0, B - T) };
  }
  const boxes = interactive.filter((e) => !e.matches('input,textarea,select') && !e.closest('[role=tablist] , .segmented, .seg, [role=radiogroup], .pal-list, [role=listbox], [role=menu], .menu')).map((e) => ({ e, r: clipRect(e) })).filter((x) => x.r.width > 1 && x.r.height > 1);
  // Overlays (toasts, popovers, drawers) are meant to sit above the page: compare controls only within the same layer.
  // Toasts vs. the composer / inspector tabs / commit box are asserted by the dedicated B2 test instead.
  const layerOf = (el) => {
    if (el.closest('.toasts')) return 'toast';
    if (el.closest('.popover')) return 'popover';
    const d = el.closest('.sidebar, .inspector');
    if (d && getComputedStyle(d).position === 'absolute') return d.classList.contains('sidebar') ? 'drawer-side' : 'drawer-insp';
    return 'page';
  };
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
    if (layerOf(a.e) !== layerOf(b.e)) continue;
    const hOver = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const vOver = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    const vGap = Math.max(b.r.top - a.r.bottom, a.r.top - b.r.bottom);
    const hGap = Math.max(b.r.left - a.r.right, a.r.left - b.r.right);
    if (hOver > 0.5 * Math.min(a.r.width, b.r.width) && vGap > -0.5 && vGap < 1) add('touching', 'warn', a.e, `0px vertical gap to ${path(b.e)}`);
    else if (vOver > 0.5 * Math.min(a.r.height, b.r.height) && hGap > -0.5 && hGap < 1) add('touching', 'warn', a.e, `0px horizontal gap to ${path(b.e)}`);
    else if (hOver > 1 && vOver > 1 && hOver * vOver > 4) add('overlap', 'error', a.e, `overlaps ${path(b.e)} by ${hOver.toFixed(0)}x${vOver.toFixed(0)}`);
  }

  // in-flow sibling overlap (non-interactive too)
  const flow = (e) => { const p = getComputedStyle(e).position; return p === 'static' || p === 'relative' || p === 'sticky'; };
  const parents = new Set(vis.map((e) => e.parentElement).filter(Boolean));
  for (const p of parents) {
    if (getComputedStyle(p).display === 'contents') continue;
    const kids = [...p.children].filter((k) => visSet.has(k) && flow(k) && !(k instanceof SVGElement));
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 1 && h > 1 && w * h > 4) {
        const neg = (k) => { const m = getComputedStyle(k); return parseFloat(m.marginTop) < 0 || parseFloat(m.marginLeft) < 0 || parseFloat(m.marginRight) < 0 || parseFloat(m.marginBottom) < 0; };
        if (neg(kids[i]) || neg(kids[j])) continue; // intentional negative-margin overlap (resizers etc.)
        add('overlap', 'error', kids[i], `overlaps sibling ${path(kids[j])} by ${w.toFixed(0)}x${h.toFixed(0)}`);
      }
    }
  }
  // de-dupe
  const seen = new Set();
  return issues.filter((i) => { const k = i.rule + i.sel + i.msg; if (seen.has(k)) return false; seen.add(k); return true; });
}

export interface LintIssue { rule: string; severity: 'error' | 'warn'; sel: string; msg: string }

export async function lintPage(page: Page, opts: { brand?: 'horizon' | 'warm' } = {}): Promise<LintIssue[]> {
  // let finite animations (dialog pop / fade) finish: contrast is measured on the settled state, not mid-fade
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) { // new toasts / dialogs can start while we wait: repeat until nothing finite is running
      const done = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
      if (!done.length) return;
      await Promise.all(done.map((a) => a.finished.catch(() => undefined)));
    }
  });
  return page.evaluate(lintInPage, { brand: opts.brand ?? 'horizon' });
}

export const errorsOf = (issues: LintIssue[]): LintIssue[] => issues.filter((i) => i.severity === 'error');

/**
 * Keyboard-only walk: presses Tab up to `max` times, records each focused element, whether a focus indicator is
 * visible (outline or box-shadow differs from the unfocused state), and returns the order + problems.
 */
export async function keyboardRun(page: Page, max = 60) {
  const out = [];
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
      const label = el.getAttribute('aria-label') || (el.innerText || '').trim().slice(0, 40) || el.getAttribute('title') || el.getAttribute('placeholder') || el.tagName;
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      // also accept focus-within rings on a wrapper (e.g. composer, search)
      let wrapRing = false;
      for (let p = el.parentElement, k = 0; p && k < 3; p = p.parentElement, k++) { const ps = getComputedStyle(p); if ((ps.outlineStyle !== 'none' && parseFloat(ps.outlineWidth) > 0) || (ps.boxShadow && ps.boxShadow !== 'none' && p.matches(':focus-within'))) wrapRing = true; }
      return { tag: el.tagName.toLowerCase(), cls: el.className?.toString().slice(0, 40), label: label.replace(/\s+/g, ' '), ring, wrapRing, visible };
    });
    if (!info) { out.push({ label: '(body)' }); continue; }
    out.push(info);
  }
  return out;
}

export function formatIssues(issues: LintIssue[]): string {
  const by = {};
  for (const i of issues) (by[i.rule] ??= []).push(i);
  return Object.entries(by).map(([rule, list]) => `${rule} (${list.length})\n` + list.slice(0, 25).map((i) => `  [${i.severity}] ${i.sel}\n      ${i.msg}`).join('\n')).join('\n');
}
