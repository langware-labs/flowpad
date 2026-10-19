import { Trans } from '@lingui/react/macro';
/**
 * A live-session lifecycle line ("Dana approved the live session") — a slim,
 * centered, messenger-style system line, never a bubble. Rendered inside the
 * session view (the thread hides session lines).
 */
export function SessionEventLine({
  text,
  onRetry,
  retrying,
}: {
  text: string;
  /** A failed turn's line: send the failed prompt again into the session. */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div data-testid="session-event-line" className="py-0.5 text-center text-[11px] italic text-muted-foreground/80">
      {text}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          data-testid="session-event-retry"
          className="ms-2 rounded border border-border px-2 py-0.5 font-medium not-italic text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          <Trans>Retry</Trans>
        </button>
      )}
    </div>
  );
}
