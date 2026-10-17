// Scrutiniser pass 1 NIT 1/2: raw-HTML sinks only ever receive Shiki output (which escapes the code), and links built
// from tool input are http(s) only. A future "fall back to raw HTML" would turn these sinks into XSS (= RCE here).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { highlight, highlightLines } from './shiki';
import { isHttpUrl } from './utils';

const SRC = path.resolve(__dirname, '..');
function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tsxFiles(p) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('dangerouslySetInnerHTML only receives Shiki output', () => {
  it('every sink is a known Shiki consumer and takes an html/hl value from lib/shiki', () => {
    const sinks: string[] = [];
    for (const f of tsxFiles(SRC)) {
      const src = fs.readFileSync(f, 'utf8');
      const uses = [...src.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]*)\}\}/g)];
      if (!uses.length) continue;
      sinks.push(path.relative(SRC, f));
      expect(src, `${f} must get its HTML from lib/shiki`).toMatch(/from '(\.\.\/)+lib\/shiki'|from '\.\/shiki'/);
      for (const u of uses) expect(u[1]!.trim(), `${f}: unexpected __html source`).toMatch(/^(html|hl\[i\])( \|\| ' ')?$/);
    }
    expect(sinks.sort()).toEqual(['components/DiffView.tsx', 'components/Markdown.tsx', 'panels/FilesPanel.tsx', 'panels/changes/FileDiff.tsx']);
  });

  it('Shiki escapes markup in code (also per line), and unsupported languages return null (rendered as text)', async () => {
    const evil = '<img src=x onerror="alert(1)">\n<script>alert(document.cookie)</script>\n"><svg onload=alert(1)>';
    for (const lang of ['html', 'markdown', 'typescript', 'bash']) {
      const html = (await highlight(evil, lang))!;
      expect(html).toBeTruthy();
      expect(html).not.toMatch(/<img|<script|<svg/i);
      expect(html).toContain('&#x3C;'); // escaped '<'
      const lines = (await highlightLines(evil, lang))!;
      expect(lines).toHaveLength(3);
      for (const l of lines) expect(l).not.toMatch(/<(img|script|svg)/i);
    }
    expect(await highlight(evil, 'no-such-language')).toBeNull();
    expect(await highlight(evil, null)).toBeNull();
  });
});

describe('links from tool input', () => {
  it('only http(s) URLs become hrefs', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true);
    expect(isHttpUrl('http://127.0.0.1:3000')).toBe(true);
    for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:x', '//evil.example', 'not a url']) expect(isHttpUrl(u)).toBe(false);
  });
});
