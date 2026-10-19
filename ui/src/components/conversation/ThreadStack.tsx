import { Trans } from '@lingui/react/macro';
import { Layers } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * One thread, packed into a single row.
 *
 * The head message renders normally; everything behind it is a stack of thin
 * offset cards — the count you can see rather than a number you have to read.
 * Clicking opens the thread, which is a NAVIGATION (`?thread=<id>`), so this
 * component takes a callback and never touches the URL itself: the caller
 * owns the dock, exactly as `SessionCard` does.
 *
 * A one-message thread renders bare — a "1 message" affordance is noise, and
 * an email that never got a reply should look like any other message.
 */
export function ThreadStack({
  messageCount,
  onOpenThread,
  children,
}: {
  /** Authoritative count from `MessageThread.message_count` when known. */
  messageCount: number;
  onOpenThread?: () => void;
  /** The head (newest) message's bubble. */
  children: ReactNode;
}) {
  if (messageCount <= 1) return <>{children}</>;

  const earlier = messageCount - 1;
  // Two cards is enough to read as "there is more behind this" — a stack that
  // grows with the thread would push the head message down the page.
  const shims = Math.min(earlier, 2);

  return (
    <div data-testid="thread-stack" className="relative">
      {/* The stack, drawn BEHIND the head: each shim is inset and pushed down,
          so the head sits on top of a visible pile. */}
      {Array.from({ length: shims }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 rounded border border-border/50 bg-muted/20"
          style={{
            top: `${(i + 1) * 3}px`,
            left: `${(i + 1) * 6}px`,
            right: `${(i + 1) * 6}px`,
            bottom: `-${(i + 1) * 3}px`,
            zIndex: -(i + 1),
          }}
        />
      ))}
      <div className="relative rounded bg-background">{children}</div>
      <button
        type="button"
        onClick={onOpenThread}
        disabled={!onOpenThread}
        data-testid="thread-stack-open"
        className="ms-10 mt-1 inline-flex items-center gap-1.5 rounded-full border border-sky-400/40 bg-sky-500/10 px-2.5 py-0.5 text-[11px] text-sky-700 transition-colors hover:bg-sky-500/20 disabled:pointer-events-none disabled:opacity-60 dark:text-sky-300"
      >
        <Layers className="h-3 w-3" />
        <Trans>{earlier} earlier in this thread</Trans>
      </button>
    </div>
  );
}
