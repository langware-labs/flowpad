import { Trans, useLingui } from '@lingui/react/macro';
import { RemoteWorkerSession } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { byWorkerSessionActivityDesc, sessionsQuery } from '@src/hooks/useRemoteWorkerSessions';
import { isLiveSessionOpen } from '@src/components/conversation/session-card-state';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useState } from 'react';

/** Footer chip: red dot + count of open live sessions; hidden when there are none.
 *  Click lists them; a row opens that session's dock. */
export function LiveSessionsChip() {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);
  const { data: sessions = [] } = useEntitiesQuery<RemoteWorkerSession>(sessionsQuery);

  // Not memoized: Date.now() must be read each render for the expiry check.
  const now = Date.now();
  const live = sessions.filter((s) => isLiveSessionOpen(s, now)).sort(byWorkerSessionActivityDesc);

  if (live.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] hover:bg-accent"
          title={t`Open live sessions`}
          aria-label={t`${live.length} open live sessions`}
          data-testid="footer-live-sessions"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
          <span className="font-medium text-red-600 dark:text-red-400">{live.length}</span>
          <span className="cq-helpdesk-label">
            <Trans>Live</Trans>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        {live.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid="footer-live-session-row"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-xs hover:bg-accent"
            onClick={() => {
              setOpen(false);
              navigation.openDock(DockPointer.forLiveSession(s.id));
            }}
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
            <span className="min-w-0 flex-1 truncate">
              {s.guest_name ?? s.guest_user_id ?? '?'} → {s.host_name ?? s.host_user_id ?? '?'}
            </span>
            <span className="shrink-0 text-muted-foreground">{s.status}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
