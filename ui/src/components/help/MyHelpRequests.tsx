import { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { helpRequests, type HelpRequestRow } from '@sdk';
import { CircleCheck, CircleDot, Clock, LifeBuoy, User } from 'lucide-react';
import { COMPACT } from '@src/components/conversation/CategoryChips';
import { AMBER_CHIP, EMERALD_CHIP, MUTED_CHIP, VIOLET_CHIP } from '@src/components/conversation/conversation-category';
import { Badge } from '@src/components/ui/badge';
import { NavBadge } from '@src/components/ui/nav-badge';
import { cn } from '@src/lib/utils';

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
  // The same tones a ticket wears in the inbox: waiting amber, live green, settled grey.
  const statusOf = (row: HelpRequestRow) => {
    if (!row.delivered) return { label: t`Not sent yet`, icon: Clock, tone: AMBER_CHIP };
    if (row.status === 'resolved') return { label: t`Resolved`, icon: CircleCheck, tone: MUTED_CHIP };
    if (row.status === 'closed') return { label: t`Closed`, icon: CircleCheck, tone: MUTED_CHIP };
    return { label: t`Open`, icon: CircleDot, tone: EMERALD_CHIP };
  };
  return (
    <>
      {rows.slice(0, SHOWN).map((row) => {
        const status = statusOf(row);
        const Recipient = row.kind === 'desk' ? LifeBuoy : User;
        return (
          <button
            key={row.conversation_id}
            type="button"
            onClick={() => onOpen(row)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-accent"
            data-testid={`help-request-${row.conversation_id}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{row.title || t`Untitled request`}</span>
              <span className="mt-0.5 flex items-center gap-1">
                {row.recipient_label && (
                  <Badge variant="outline" className={cn(COMPACT, 'min-w-0', VIOLET_CHIP)} data-chip-type="recipient">
                    <Recipient className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate">{row.recipient_label}</span>
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={cn(COMPACT, 'shrink-0', status.tone)}
                  data-chip-type="status"
                  data-status={row.delivered ? row.status : 'unsent'}
                >
                  <status.icon className="h-2.5 w-2.5" />
                  {status.label}
                </Badge>
              </span>
            </span>
            <NavBadge count={row.unread} className="static shrink-0" />
          </button>
        );
      })}
    </>
  );
}
