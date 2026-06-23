import React from 'react';
import { TooltipContent } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';

interface LastPromptTooltipProps {
  /** The most recent prompt text sent in this session, if any. */
  text: string | null | undefined;
  /** Total prompt count (shown alongside the header when > 1). */
  count?: number;
  /** Shown when there is no prompt yet (the generic tab description). */
  fallback: string;
}

/** Keep the hover card readable — clip very long prompts rather than overflow. */
const MAX_CHARS = 800;

/**
 * Content for the Prompts-icon hover card: a clear, readable view of the LAST
 * prompt used in the session. Meant to be placed inside a <TooltipContent>
 * styled wide + popover-coloured (see callers). Falls back to the generic tab
 * description before any prompt has been sent.
 */
export const LastPromptTooltip: React.FC<LastPromptTooltipProps> = ({ text, count = 0, fallback }) => {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return <span>{fallback}</span>;
  const clipped = trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) + '…' : trimmed;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
        Last prompt{count > 1 ? ` · ${count} total` : ''}
      </div>
      <div className="max-h-60 overflow-hidden whitespace-pre-wrap break-words text-xs leading-snug">
        {clipped}
      </div>
    </div>
  );
};

interface SideTabTooltipContentProps {
  side: 'top' | 'bottom';
  /** When true, render the rich last-prompt card; otherwise just `fallback`. */
  isPrompts: boolean;
  lastPromptText?: string | null;
  promptCount?: number;
  fallback: string;
}

/**
 * The <TooltipContent> for a side-tab icon, shared by the bottom ribbon and the
 * side window. The Prompts tab gets a widened popover-coloured card showing the
 * last prompt; every other tab gets the plain description string.
 */
export const SideTabTooltipContent: React.FC<SideTabTooltipContentProps> = ({
  side,
  isPrompts,
  lastPromptText,
  promptCount = 0,
  fallback,
}) => (
  <TooltipContent
    side={side}
    className={cn('text-xs', isPrompts && 'max-w-md border bg-popover text-popover-foreground shadow-md')}
  >
    {isPrompts ? (
      <LastPromptTooltip text={lastPromptText} count={promptCount} fallback={fallback} />
    ) : (
      fallback
    )}
  </TooltipContent>
);
