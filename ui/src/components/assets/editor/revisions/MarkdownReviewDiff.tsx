import { useCallback, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { Check, X } from 'lucide-react';
import { markdownComponents } from '@src/components/markdown-view';
import {
  annotate,
  buildReviewParts,
  countChanges,
  countPending,
  type Decision,
} from '@src/lib/markdown-review-diff';

interface MarkdownReviewDiffProps {
  /** Markdown of the past revision. */
  oldContent: string;
  /** Markdown of the current version. */
  newContent: string;
}

/** Parse the change id off the `rev-N` class we inject in `annotate`. */
function ridOf(className: unknown): number {
  const m = /\brev-(\d+)\b/.exec(String(className ?? ''));
  return m ? Number(m[1]) : 0;
}

/**
 * One inline change mark + its hover ✓/✕ toolbar. Semantics:
 *   insertion → ✓ accept (keep), ✕ reject (remove)
 *   deletion  → ✓ keep text (reject deletion), ✕ confirm deletion (accept)
 */
function ReviewMark({
  kind,
  className,
  children,
  onDecide,
}: {
  kind: 'ins' | 'del';
  className?: unknown;
  children?: React.ReactNode;
  onDecide: (id: number, d: Decision) => void;
}) {
  const id = ridOf(className);
  const Tag = kind;
  return (
    <Tag
      className={
        'group/mrd relative rounded-sm px-0.5 no-underline ' +
        (kind === 'ins'
          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
          : 'bg-red-500/15 text-red-700 line-through dark:text-red-300')
      }
    >
      {children}
      <span className="ml-0.5 hidden gap-0.5 align-middle no-underline group-hover/mrd:inline-flex">
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); onDecide(id, kind === 'ins' ? 'accepted' : 'rejected'); }}
          title={kind === 'ins' ? 'Keep' : 'Keep text'}
          className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-white"
        >
          <Check className="h-2.5 w-2.5" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); onDecide(id, kind === 'ins' ? 'rejected' : 'accepted'); }}
          title={kind === 'ins' ? 'Discard' : 'Confirm deletion'}
          className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    </Tag>
  );
}

/**
 * Word-style "review compare" of two markdown versions: insertions (green) and
 * deletions (red strikethrough) rendered inline in the formatted prose, with a
 * Show-changes / Final toggle and per-change hover ✓/✕. Reuses the app's markdown
 * element styling (`markdownComponents`) so it matches the standard view. Asset
 * bodies are HTML-free by project rule, so the only raw HTML is our ins/del.
 *
 * View-only: ✓/✕ and Final preview the result locally; nothing is written.
 */
export function MarkdownReviewDiff({ oldContent, newContent }: MarkdownReviewDiffProps) {
  const parts = useMemo(() => buildReviewParts(oldContent, newContent), [oldContent, newContent]);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [final, setFinal] = useState(false);

  const md = useMemo(() => annotate(parts, decisions, { final }), [parts, decisions, final]);
  const total = useMemo(() => countChanges(parts), [parts]);
  const pending = countPending(parts, decisions);

  // Stable across renders (functional setState) → lets `components` memoize.
  const decide = useCallback((id: number, d: Decision) => {
    setDecisions((prev) => ({ ...prev, [id]: d }));
  }, []);

  const components = useMemo<Components>(
    () => ({
      ...markdownComponents({ codeChrome: false }),
      ins: ({ className, children }) => <ReviewMark kind="ins" className={className} onDecide={decide}>{children}</ReviewMark>,
      del: ({ className, children }) => <ReviewMark kind="del" className={className} onDecide={decide}>{children}</ReviewMark>,
    }),
    [decide],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="inline-flex overflow-hidden rounded-md border text-xs">
          <button
            type="button"
            onClick={() => setFinal(false)}
            data-active={!final}
            className="px-3 py-1 data-[active=true]:bg-foreground data-[active=true]:text-background"
          >
            Show changes
          </button>
          <button
            type="button"
            onClick={() => setFinal(true)}
            data-active={final}
            className="px-3 py-1 data-[active=true]:bg-foreground data-[active=true]:text-background"
          >
            Final
          </button>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          {total === 0 ? 'No differences' : final ? `${total} change${total === 1 ? '' : 's'}` : `${pending} of ${total} unresolved`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5" data-testid="markdown-review-diff">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeHighlight]} components={components}>
          {md}
        </ReactMarkdown>
      </div>
    </div>
  );
}
