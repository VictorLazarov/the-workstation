const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};
export type ViewKind = 'image' | 'svg' | 'markdown' | 'text' | 'binary';

export function ext(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}

export function viewKind(path: string, encoding: 'utf8' | 'base64' | string): ViewKind {
  const e = ext(path);
  if (e === 'svg' && encoding === 'utf8') return 'svg';
  if (encoding === 'base64') return IMAGE_MIME[e] ? 'image' : 'binary';
  if (e === 'md' || e === 'mdx' || e === 'markdown') return 'markdown';
  return 'text';
}

export function imageSrc(path: string, kind: ViewKind, content: string): string {
  if (kind === 'svg') return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(content);
  return `data:${IMAGE_MIME[ext(path)] ?? 'application/octet-stream'};base64,${content}`;
}

export function formatBytes(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Entries to hide in the tree (never useful to browse). */
export const HIDDEN = new Set(['.git', '.DS_Store']);
