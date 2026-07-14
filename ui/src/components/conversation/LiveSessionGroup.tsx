import { Trans } from '@lingui/react/macro';
import { ChevronRight, Radio } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/**
 * One collapsed run of live-session messages inside the conversation feed.
 *
 * Collapsed (default) the group is a single "alive candy" pill — tiny, inline,
 * counts only ("Live session · 3 prompts · 2 replies"). Expanding reveals the
 * underlying bubbles, indented under a soft left rule so the session's turns
 * read as "happened elsewhere" against the human chat around them.
 */
export function LiveSessionGroup({
  promptCount,
  replyCount,
  defaultOpen = false,
  onOpenSession,
  children,
}: {
  sessionId: string;
  promptCount: number;
  replyCount: number;
  defaultOpen?: boolean;
  /** Navigate to the live-session view (URL-first — caller owns the dock). */
  onOpenSession?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div data-testid="live-session-group" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          data-testid="live-session-group-toggle"
          className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/10 px-2.5 py-0.5 text-[11px] text-violet-700 transition-colors hover:bg-violet-500/20 dark:text-violet-300"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          <Radio className="h-3 w-3" />
          <span className="font-medium">
            <Trans>Live session</Trans>
          </span>
          <span className="text-violet-600/80 dark:text-violet-300/80">
            <Trans>
              {promptCount} prompts · {replyCount} replies
            </Trans>
          </span>
        </button>
        {onOpenSession && (
          <button
            type="button"
            onClick={onOpenSession}
            data-testid="live-session-group-open"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <Trans>Open live session</Trans>
          </button>
        )}
      </div>
      {open && (
        <div className="ml-3 flex flex-col gap-3 border-l-2 border-violet-400/25 pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A live-session lifecycle line ("Dana approved the live session") — a slim,
 * centered, messenger-style system line, never a bubble.
 */
export function SessionEventLine({ text }: { text: string }) {
  return (
    <div
      data-testid="session-event-line"
      className="py-0.5 text-center text-[11px] italic text-muted-foreground/80"
    >
      {text}
    </div>
  );
}
