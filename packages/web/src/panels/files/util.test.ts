import { describe, expect, it } from 'vitest';
import { formatBytes, imageSrc, viewKind } from './util';

describe('files util', () => {
  it('classifies files', () => {
    expect(viewKind('a/b.png', 'base64')).toBe('image');
    expect(viewKind('a/b.PNG', 'base64')).toBe('image');
    expect(viewKind('a/b.zip', 'base64')).toBe('binary');
    expect(viewKind('a/b.svg', 'utf8')).toBe('svg');
    expect(viewKind('README.md', 'utf8')).toBe('markdown');
    expect(viewKind('x.ts', 'utf8')).toBe('text');
  });
  it('builds data urls', () => {
    expect(imageSrc('a.png', 'image', 'AAA')).toBe('data:image/png;base64,AAA');
    expect(imageSrc('a.svg', 'svg', '<svg a="1"/>')).toContain('%3Csvg');
  });
  it('formats bytes', () => { expect(formatBytes(512)).toBe('512 B'); expect(formatBytes(2048)).toBe('2.0 KB'); expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB'); });
});
