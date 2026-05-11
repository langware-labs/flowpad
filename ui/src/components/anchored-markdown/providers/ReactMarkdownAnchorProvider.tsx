import { useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { useLineRectMap } from '../hooks/useLineRectMap';
import type { LineAnchorProvider } from '../types';

/**
 * Hook that returns:
 *   - `body` — rendered markdown with data-line attributes on every block.
 *   - `provider` — a LineAnchorProvider exposing getRect(line) + subscribe().
 *
 * Usage:
 *   const { body, provider } = useReactMarkdownAnchor(source);
 *   return <AnchoredSurface provider={provider} leftTracks={…} rightTracks={…}>{body}</AnchoredSurface>
 */
export function useReactMarkdownAnchor(source: string): {
  body: React.ReactNode;
  provider: LineAnchorProvider;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const rectMap = useLineRectMap(ref);

  const body = (
    <div ref={ref} className="anchored-md-body relative px-4 py-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={anchoredComponents}
      >
        {source}
      </ReactMarkdown>
    </div>
  );

  return { body, provider: rectMap };
}

/**
 * The component overrides — each block-level element receives `node` (per
 * react-markdown v10 contract) and stamps its source line on the rendered
 * element. Inline elements (em, strong, code) are not anchored — they live
 * inside their parent block.
 */
function dataLine(node: Parameters<NonNullable<Components['p']>>[0]['node']): number | undefined {
  const line = node?.position?.start?.line;
  return typeof line === 'number' ? line : undefined;
}

const anchoredComponents: Components = {
  h1: ({ node, children, ...rest }) => (
    <h1 data-line={dataLine(node)} className="mb-4 mt-2 scroll-m-20 text-3xl font-bold tracking-tight first:mt-0" {...rest}>
      {children}
    </h1>
  ),
  h2: ({ node, children, ...rest }) => (
    <h2 data-line={dataLine(node)} className="mb-3 mt-6 scroll-m-20 border-b pb-1.5 text-2xl font-semibold tracking-tight first:mt-0" {...rest}>
      {children}
    </h2>
  ),
  h3: ({ node, children, ...rest }) => (
    <h3 data-line={dataLine(node)} className="mb-2 mt-4 scroll-m-20 text-xl font-semibold tracking-tight" {...rest}>
      {children}
    </h3>
  ),
  h4: ({ node, children, ...rest }) => (
    <h4 data-line={dataLine(node)} className="mb-2 mt-3 scroll-m-20 text-lg font-semibold tracking-tight" {...rest}>
      {children}
    </h4>
  ),
  p: ({ node, children, ...rest }) => (
    <p data-line={dataLine(node)} className="my-2 leading-7" {...rest}>
      {children}
    </p>
  ),
  ul: ({ node, children, ...rest }) => (
    <ul data-line={dataLine(node)} className="my-2 ml-6 list-disc [&>li]:mt-1" {...rest}>
      {children}
    </ul>
  ),
  ol: ({ node, children, ...rest }) => (
    <ol data-line={dataLine(node)} className="my-2 ml-6 list-decimal [&>li]:mt-1" {...rest}>
      {children}
    </ol>
  ),
  li: ({ node, children, ...rest }) => (
    <li data-line={dataLine(node)} {...rest}>
      {children}
    </li>
  ),
  blockquote: ({ node, children, ...rest }) => (
    <blockquote data-line={dataLine(node)} className="my-3 border-l-2 pl-4 italic text-muted-foreground" {...rest}>
      {children}
    </blockquote>
  ),
  pre: ({ node, children, ...rest }) => (
    <pre data-line={dataLine(node)} className="my-3 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground" {...rest}>
      {children}
    </pre>
  ),
  code: ({ children, ...rest }) => (
    <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em] text-muted-foreground" {...rest}>
      {children}
    </code>
  ),
  hr: () => <hr className="my-4 border-muted" />,
};
