import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { helpRequests, type HelpRequestRow } from '@sdk';
import { NavBadge } from '@src/components/ui/nav-badge';

/** How many requests a list shows: the newest. */
const SHOWN = 8;

/** My help requests, newest first — read again whenever `refresh` changes. */
export function useHelpRequests(refresh: unknown): HelpRequestRow[] {
  const [rows, setRows] = useState<HelpRequestRow[]>([]);
  useEffect(() => {
    let live = true;
    void helpRequests()
      .catch((): HelpRequestRow[] => [])
      .then((next) => live && setRows(next));
    return () => {
      live = false;
    };
  }, [refresh]);
  return rows;
}

/** One line per request: what was asked, of whom, and where it stands. */
export function HelpRequestList({ rows, onOpen }: { rows: HelpRequestRow[]; onOpen: (row: HelpRequestRow) => void }) {
  const { t } = useLingui();
  const statusOf = (row: HelpRequestRow) => {
    if (!row.delivered) return t`Not sent yet`;
    if (row.status === 'resolved') return t`Resolved`;
    return row.status === 'closed' ? t`Closed` : t`Open`;
  };
  return (
    <>
      {rows.slice(0, SHOWN).map((row) => (
        <button
          key={row.conversation_id}
          type="button"
          onClick={() => onOpen(row)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-accent"
          data-testid={`help-request-${row.conversation_id}`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate">{row.title || t`Untitled request`}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {[row.recipient_label, statusOf(row)].filter(Boolean).join(' · ')}
            </span>
          </span>
          <NavBadge count={row.unread} className="static shrink-0" />
        </button>
      ))}
    </>
  );
}
