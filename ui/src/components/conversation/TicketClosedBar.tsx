import { useLingui } from '@lingui/react/macro';

/** "10:19 AM": the time of day, in the person's own format. */
function timeOfDay(at: string | Date | null | undefined): string {
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : '';
}

/**
 * Under the composer of a closed ticket, for the person who asked: who closed it and when, and the two ways on --
 * Reopen it, or Ask something new. ``closedBy`` is the desk's name; null when the person closed it themselves.
 * Clicks only call what they are given.
 */
export function TicketClosedBar({
  closedBy,
  at,
  busy,
  onReopen,
  onAskNew,
}: {
  closedBy: string | null;
  at: string | Date | null | undefined;
  busy: boolean;
  onReopen: () => void;
  onAskNew: () => void;
}) {
  const { t } = useLingui();
  const time = timeOfDay(at);
  const who = closedBy ?? t`You`;
  const button = 'rounded-md border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50';
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
      data-testid="ticket-closed-bar"
    >
      <span className="text-muted-foreground">{t`✓ ${who} closed this ticket · ${time}`}</span>
      <span className="flex-1" />
      <button type="button" className={button} onClick={onReopen} disabled={busy} data-testid="ticket-closed-reopen">
        {t`Reopen`}
      </button>
      <button type="button" className={button} onClick={onAskNew} data-testid="ticket-closed-ask-new">
        {t`Ask something new`}
      </button>
    </div>
  );
}
