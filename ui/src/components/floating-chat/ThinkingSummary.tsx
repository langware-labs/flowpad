import { FlowData, FlowDataType } from '@sdk';
import { useDataStreamText } from '@sdk/react/hooks';
import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import { t } from '@lingui/core/macro';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';

interface ThinkingSummaryProps {
  /** Every REASONING frame collected for this turn's `thinking` group, in
   *  order — see `groupTurnEvents`'s `thinking` TurnGroup. */
  events: FlowData[];
}

/**
 * A turn's thinking, rendered as its own collapsible chat entry — not folded
 * into {@link ToolEntryRow}'s "N events" chip. Starts COLLAPSED so paragraphs
 * of deliberation don't bury the actual reply under it.
 *
 * Only the trailing event can still be streaming (each REASONING block gets
 * its own group-id, consolidated in place); `useDataStreamText` mirrors the
 * live-update pattern `ExecutionMessage` uses for the in-flight reply.
 */
export function ThinkingSummary({ events }: ThinkingSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  const last = events[events.length - 1] as FlowData | undefined;
  const shouldStreamLast = !!last && last.dataType === FlowDataType.String;
  const streamState = useDataStreamText(shouldStreamLast ? last : null);

  const text = useMemo(() => {
    const parts = events.map((event, i) => {
      if (i === events.length - 1 && streamState.isStreaming && streamState.partialContent) {
        return streamState.partialContent;
      }
      return event.content;
    });
    return parts.filter((part) => part.trim()).join('\n\n');
  }, [events, streamState.isStreaming, streamState.partialContent]);

  // Nothing to show yet (e.g. a delta stream that hasn't produced its first
  // chunk) — render nothing rather than an empty disclosure.
  if (!text.trim()) return null;

  const isStreaming = shouldStreamLast && streamState.isStreaming;

  return (
    <div className="my-0.5" data-testid="thinking-disclosure">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        data-testid="thinking-disclosure-toggle"
        aria-expanded={expanded}
        title={t`Thinking`}
        className={[
          'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 px-2 py-1',
          'text-[13px] leading-none text-muted-foreground',
          'bg-muted/40 hover:bg-muted hover:text-foreground',
          'transition-colors',
        ].join(' ')}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0" />
        )}
        <Sparkles className={cn('h-3.5 w-3.5 flex-shrink-0', isStreaming && 'animate-pulse')} />
        <span className="whitespace-nowrap font-medium">{t`Thinking`}</span>
      </button>

      {expanded && (
        <div className="ms-3 mt-1 max-w-full border-s border-border/60 ps-3 text-[13px] leading-6 text-muted-foreground">
          <MarkdownView value={text} compact />
        </div>
      )}
    </div>
  );
}
