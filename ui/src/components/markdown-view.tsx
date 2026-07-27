import { copyToClipboard } from '@sdk';
import { Check, Copy } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

/** Parse the `language-xxx` class rehype-highlight puts on the inner <code>. */
function extractLanguage(children: React.ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children;
  if (React.isValidElement(child)) {
    const cls = (child.props as { className?: string })?.className ?? '';
    const m = cls.match(/language-([\w-]+)/);
    if (m) return m[1];
  }
  return '';
}

/**
 * Code block with a calm header (language label) + a Copy button. Theme-aware
 * via semantic tokens. `codeChrome={false}` falls back to a bare <pre> (the
 * review-diff viewer keeps the minimal look).
 */
function CodeBlock({ children, codeChrome }: { children: React.ReactNode; codeChrome: boolean }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const { t } = useLingui();

  if (!codeChrome) {
    return (
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">
        {children}
      </pre>
    );
  }

  const language = extractLanguage(children);
  const copy = async () => {
    await copyToClipboard(preRef.current?.textContent ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group my-3 overflow-hidden rounded-lg border bg-muted/60">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {language || t`code`}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t`Copy code`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t`Copied` : t`Copy`}
        </button>
      </div>
      <pre
        ref={preRef}
        className="max-h-[480px] overflow-auto px-3 py-3 font-mono text-[13px] leading-relaxed text-foreground"
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * The app's canonical markdown element styling. Shared so any markdown surface
 * (the chat, the review-diff viewer) renders prose identically.
 */
export function markdownComponents({
  compact = false,
  codeChrome = true,
}: { compact?: boolean; codeChrome?: boolean } = {}): Components {
  const paragraphClass = compact
    ? 'mb-2 leading-6 last:mb-0 [&:not(:first-child)]:mt-2'
    : 'mb-4 leading-7 last:mb-0 [&:not(:first-child)]:mt-6';

  // Every text-bearing block carries dir="auto" so its base direction (and
  // with it alignment + punctuation side) follows the block's first strong
  // character instead of the app UI locale — Hebrew/Arabic content renders
  // RTL even when the app is in an LTR language. Direction-sensitive spacing
  // uses logical utilities (ms-*, ps-*, border-s, text-start) so it flips
  // with the resolved direction.
  return {
    code: ({ children }) => (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>
    ),
    pre: ({ children }) => <CodeBlock codeChrome={codeChrome}>{children}</CodeBlock>,
    p: ({ children }) => (
      <p dir="auto" className={paragraphClass}>
        {children}
      </p>
    ),
    h1: ({ children }) => (
      <h1 dir="auto" className="mb-4 scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 dir="auto" className="mb-3 scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 dir="auto" className="mb-2 scroll-m-20 text-2xl font-semibold tracking-tight">
        {children}
      </h3>
    ),
    ul: ({ children }) => (
      <ul dir="auto" className="my-6 ms-6 list-disc [&>li]:mt-2">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol dir="auto" className="my-6 ms-6 list-decimal [&>li]:mt-2">
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li dir="auto" className="mt-2">
        {children}
      </li>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
      >
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote dir="auto" className="mt-6 border-s-2 ps-6 italic text-muted-foreground">
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="my-6 w-full overflow-auto">
        <table className="w-full">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="border-b border-muted">{children}</tr>,
    th: ({ children }) => (
      <th dir="auto" className="px-4 py-2 text-start font-semibold">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td dir="auto" className="px-4 py-2 align-top">
        {children}
      </td>
    ),
    hr: () => <hr className="my-4 border-muted" />,
  };
}

export const MarkdownView = ({
  value,
  compact = false,
  codeChrome = true,
}: {
  value: string;
  compact?: boolean;
  codeChrome?: boolean;
}) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeHighlight]}
    components={markdownComponents({ compact, codeChrome })}
  >
    {value}
  </ReactMarkdown>
);
