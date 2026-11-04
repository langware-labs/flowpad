import { Trans, useLingui } from '@lingui/react/macro';
import { RemoteWorkerSession, RemoteWorkerSessionStatus } from '@sdk';
import { sessionRole } from '@src/hooks/useConversationSessions';
import { useAuth } from '@sdk/react/hooks';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { byWorkerSessionActivityDesc, sessionsQuery } from '@src/hooks/useRemoteWorkerSessions';
import { isLiveSessionOpen } from '@src/components/conversation/session-card-state';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@src/lib/utils';

const PROMPT_STATUSES = new Set([RemoteWorkerSessionStatus.RUNNING, RemoteWorkerSessionStatus.PENDING]);

type Pulse = 'sent' | 'received' | null;

/** Which way the session's latest activity went: the guest sends prompts (the host
 *  starts or queues a run), the host sends replies (the run settles). */
function activityDirection(s: RemoteWorkerSession, myUserId: string | undefined): Pulse {
  const prompt = PROMPT_STATUSES.has(s.status as RemoteWorkerSessionStatus);
  const iAmHost = sessionRole(s, myUserId) === 'host';
  return prompt === iAmHost ? 'received' : 'sent';
}

/** A short pulse each time the newest session's activity clock moves forward (never
 *  on the first value seen): red for a message received, blue for one sent. */
function usePulse(latest: RemoteWorkerSession | undefined, myUserId: string | undefined): Pulse {
  const clock = latest?.last_activity_at ?? '';
  const seen = useRef(clock);
  const [pulse, setPulse] = useState<Pulse>(null);
  useEffect(() => {
    if (!latest || !clock || clock <= seen.current) return;
    seen.current = clock;
    setPulse(activityDirection(latest, myUserId));
    const id = window.setTimeout(() => setPulse(null), 700);
    return () => window.clearTimeout(id);
    // Only a clock move pulses; `latest` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock]);
  return pulse;
}

/** Footer chip: red dot + count of open live sessions; hidden when there are none.
 *  Click lists them; a row opens that session's dock. It pulses red when a message
 *  is received and blue when one is sent. */
export function LiveSessionsChip() {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [open, setOpen] = useState(false);
  const { data: sessions = [] } = useEntitiesQuery<RemoteWorkerSession>(sessionsQuery);

  // Not memoized: Date.now() must be read each render for the expiry check.
  const now = Date.now();
  const live = sessions.filter((s) => isLiveSessionOpen(s, now)).sort(byWorkerSessionActivityDesc);

  const { cloudUser } = useAuth();
  // `live` is sorted newest activity first.
  const pulse = usePulse(live[0], cloudUser?.id);

  if (live.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] transition-shadow duration-500 hover:bg-accent',
            pulse === 'received' && 'shadow-[0_0_10px_2px_rgba(239,68,68,0.6)] ring-1 ring-red-500/60',
            pulse === 'sent' && 'shadow-[0_0_10px_2px_rgba(59,130,246,0.6)] ring-1 ring-blue-500/60',
          )}
          data-pulse={pulse ?? undefined}
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
