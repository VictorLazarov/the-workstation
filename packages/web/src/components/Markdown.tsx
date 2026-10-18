import { memo, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlight } from '../lib/shiki';
import { CopyButton } from './ui';

export function CodeBlock({ code, lang, className = '' }: { code: string; lang?: string | null; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (code.length > 40_000) return;
    highlight(code, lang).then((h) => { if (live) setHtml(h); });
    return () => { live = false; };
  }, [code, lang]);
  return (
    <div className={`codeblock ${className}`}>
      <div className="codeblock-bar">
        <span className="codeblock-lang">{lang || 'text'}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      {html ? <div className="codeblock-body shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="codeblock-body"><code>{code}</code></pre>}
    </div>
  );
}

const components = {
  code({ className, children, node, ...rest }: { className?: string; children?: ReactNode; node?: unknown }) {
    const m = /language-([\w+-]+)/.exec(className ?? '');
    const text = String(children ?? '');
    if (!m && !text.includes('\n')) return <code className="inline-code" {...rest}>{children}</code>;
    return <CodeBlock code={text.replace(/\n$/, '')} lang={m?.[1]} />;
  },
  pre({ children }: { children?: ReactNode }) { return <>{children}</>; },
  // a link whose href was stripped as unsafe (javascript:, data:, ...) is plain text: an <a href=""> would reopen this app in a new tab
  a({ href, children }: { href?: string; children?: ReactNode }) { return href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>; },
  table({ children }: { children?: ReactNode }) { return <div className="table-wrap"><table>{children}</table></div>; },
};

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`md${streaming ? ' streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as never}>{text}</ReactMarkdown>
    </div>
  );
});
