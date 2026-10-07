import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState, type ReactNode } from 'react';
import { RemoteWorkerSession, RemoteWorkerSessionStatus } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { formatClock } from '@src/components/lens-viewer/shared/format-utils';
import { useClock } from '@src/hooks/useActivity';
import { cn } from '@src/lib/utils';
import { sessionCardState, sessionExpiresAt, type SessionCardState } from './session-card-state';

export interface SessionCardProps {
  sessionId: string;
  /** null while the row has not synced → "requesting". */
  session: RemoteWorkerSession | null;
  role: 'host' | 'guest' | 'observer';
  promptCount: number;
  replyCount: number;
  /** URL-first: the caller navigates (`openDock(DockPointer.forLiveSession)`). */
  onOpen: () => void;
  /** Host + pending only: approve and remember this guest (later sessions start without asking). */
  onApprove?: () => Promise<void>;
  /** Host + pending only: approve this session only. */
  onApproveOnce?: () => Promise<void>;
  onDecline?: () => Promise<void>;
  /** Either side, while live: end the session. */
  onDisconnect?: () => Promise<void>;
  /** The session's last prompt failed and nothing answered it since. */
  lastPromptFailed?: boolean;
  /** Guest only: send the failed prompt again into this session. */
  onRetry?: () => Promise<void>;
}

const TONE: Record<SessionCardState, string> = {
  requesting: 'text-muted-foreground',
  pending: 'text-amber-700 dark:text-amber-300',
  active: 'text-emerald-700 dark:text-emerald-300',
  paused: 'text-muted-foreground',
  ended: 'text-muted-foreground',
  declined: 'text-red-700 dark:text-red-300',
};

const DOT: Record<SessionCardState, string> = {
  requesting: 'bg-muted-foreground',
  pending: 'bg-amber-500',
  active: 'bg-emerald-500',
  paused: 'bg-muted-foreground',
  ended: 'bg-muted-foreground',
  declined: 'bg-red-500',
};

const ACTION =
  'rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** Time since the host approved — a ticking `m:ss` on the shared clock. */
function SinceApproved({ approvedAt }: { approvedAt: string }) {
  const now = useClock();
  const ms = now - Date.parse(approvedAt);
  if (!Number.isFinite(ms)) return null;
  return (
    <span className="shrink-0 font-mono tabular-nums text-muted-foreground" data-testid="session-card-elapsed">
      {formatClock(ms)}
    </span>
  );
}

/** True once the session passes its length cap — one timer at the deadline, not a per-second tick. */
function useSessionExpired(session: RemoteWorkerSession | null): boolean {
  const ends = sessionExpiresAt(session);
  const [expired, setExpired] = useState(() => ends !== null && Date.now() >= ends);
  useEffect(() => {
    const left = ends === null ? null : ends - Date.now();
    setExpired(left !== null && left <= 0);
    if (left === null || left <= 0) return;
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [ends]);
  return expired;
}

/**
 * A live session's ONE line in the conversation: `Live session · <other side>`
 * and its status. The whole line opens the session view, where the turns live.
 * The host answers a request here once (Approve — and remember this guest —,
 * Approve once, or Decline); once it is live the
 * line carries the message count, the time since approval, and a red Disconnect.
 */
export function SessionCard({
  sessionId,
  session,
  role,
  promptCount,
  replyCount,
  onOpen,
  onApprove,
  onApproveOnce,
  onDecline,
  onDisconnect,
  lastPromptFailed,
  onRetry,
}: SessionCardProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState<'approve' | 'approve-once' | 'decline' | 'disconnect' | 'retry' | null>(null);
  // Past the length cap the session is over on this side too, whatever the row says.
  const expired = useSessionExpired(session);
  const state = expired ? 'ended' : sessionCardState(session?.status);
  const running = state === 'active' && session?.status === RemoteWorkerSessionStatus.RUNNING;
  const host = session?.host_name?.trim() || t`the host`;
  const guest = session?.guest_name?.trim() || t`the guest`;
  const other = role === 'host' ? guest : host;
  const Icon = iconForType(RemoteWorkerSession.type);
  // The host answering a request; a failed prompt on a live session.
  const answering = role === 'host' && state === 'pending';
  const failedLive = !!lastPromptFailed && state === 'active';

  const status = (() => {
    switch (state) {
      case 'requesting':
        return role === 'host' ? t`requested` : t`requesting…`;
      case 'pending':
        return role === 'host' ? t`wants to run prompts on your machine` : t`awaiting approval`;
      case 'active':
        return running ? t`working…` : t`connected`;
      case 'paused':
        return t`paused`;
      case 'ended':
        return t`ended`;
      case 'declined':
        return t`declined`;
    }
  })();

  const run = async (which: NonNullable<typeof busy>, fn?: () => Promise<void>) => {
    if (!fn || busy) return;
    setBusy(which);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const button = (
    which: NonNullable<typeof busy>,
    fn: (() => Promise<void>) | undefined,
    cls: string,
    label: ReactNode,
  ) =>
    fn ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void run(which, fn);
        }}
        disabled={!!busy}
        data-testid={`session-card-${which}`}
        className={cn(ACTION, cls)}
      >
        {label}
      </button>
    ) : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid="session-card"
      data-session-id={sessionId}
      data-status={state}
      title={t`Open the live session`}
      className="flex w-full max-w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate font-medium text-foreground" data-testid="session-card-name">
        <Trans>Live session · {other}</Trans>
      </span>
      <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[state], running && 'animate-pulse')} aria-hidden />
      <span className={cn('shrink-0', TONE[state])} data-testid="session-card-status">
        {status}
      </span>
      {state === 'active' && (
        <>
          <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="session-card-counts">
            <Plural value={promptCount + replyCount} one="# message" other="# messages" />
          </span>
          {session?.approved_at && <SinceApproved approvedAt={session.approved_at} />}
        </>
      )}
      {failedLive && (
        <span className="shrink-0 font-medium text-red-700 dark:text-red-300" data-testid="session-card-failed">
          <Trans>Last prompt failed</Trans>
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1.5">
        {failedLive &&
          button('retry', onRetry, 'border border-border text-foreground hover:bg-muted', <Trans>Retry</Trans>)}
        {answering && (
          <>
            {button('approve', onApprove, 'bg-blue-600 text-white hover:bg-blue-500', <Trans>Approve</Trans>)}
            {button(
              'approve-once',
              onApproveOnce,
              'border border-border text-foreground hover:bg-muted',
              <Trans>Approve once</Trans>,
            )}
            {button(
              'decline',
              onDecline,
              'border border-border text-foreground hover:bg-muted',
              <Trans>Decline</Trans>,
            )}
          </>
        )}
        {(state === 'active' || state === 'paused') &&
          button(
            'disconnect',
            onDisconnect,
            'bg-destructive text-destructive-foreground hover:bg-destructive/90',
            <Trans>Disconnect</Trans>,
          )}
      </span>
    </div>
  );
}
