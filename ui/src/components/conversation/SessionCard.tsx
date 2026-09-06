import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { RemoteWorkerSession, RemoteWorkerSessionStatus } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { cn } from '@src/lib/utils';
import { sessionCardState, type SessionCardState } from './session-card-state';

export interface SessionCardProps {
  sessionId: string;
  /** null while the row has not synced → "requesting". */
  session: RemoteWorkerSession | null;
  role: 'host' | 'guest' | 'observer';
  promptCount: number;
  replyCount: number;
  /** URL-first: the caller navigates (`openDock(DockPointer.forLiveSession)`). */
  onOpen: () => void;
  /** Host + pending only. */
  onApprove?: () => Promise<void>;
  onDecline?: () => Promise<void>;
}

const TONE: Record<SessionCardState, string> = {
  requesting: 'border-border text-muted-foreground',
  pending: 'border-amber-500/60 text-amber-700 dark:text-amber-300',
  active: 'border-emerald-500/60 text-emerald-700 dark:text-emerald-300',
  paused: 'border-border text-muted-foreground',
  ended: 'border-border text-muted-foreground',
  declined: 'border-red-500/40 text-red-700 dark:text-red-300',
  error: 'border-red-500/40 text-red-700 dark:text-red-300',
};

const DOT: Record<SessionCardState, string> = {
  requesting: 'bg-muted-foreground',
  pending: 'bg-amber-500',
  active: 'bg-emerald-500',
  paused: 'bg-muted-foreground',
  ended: 'bg-muted-foreground',
  declined: 'bg-red-500',
  error: 'bg-red-500',
};

/**
 * The compact horizontal session card attached under the message that opened
 * a live session: status, whose machine, prompt/reply counts, Approve/Decline
 * for the host while pending, and Open for everyone. One row, never a stack —
 * the session view is where the turns live.
 */
export function SessionCard({ sessionId, session, role, promptCount, replyCount, onOpen, onApprove, onDecline }: SessionCardProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const state = sessionCardState(session?.status);
  const running = session?.status === RemoteWorkerSessionStatus.RUNNING;
  const host = session?.host_name?.trim() || t`the host`;
  const guest = session?.guest_name?.trim() || t`the guest`;
  const Icon = iconForType(RemoteWorkerSession.type);

  const label = (() => {
    switch (state) {
      case 'requesting':
        return role === 'host' ? t`Session requested` : t`Requesting access to ${host}'s machine`;
      case 'pending':
        return role === 'host' ? t`${guest} wants to run prompts here` : t`Awaiting ${host}`;
      case 'active':
        return role === 'host' ? t`Live · ${guest}'s session` : t`Live on ${host}'s machine`;
      case 'paused':
        return role === 'host' ? t`Paused` : t`${host} paused the session`;
      case 'ended':
        return t`Ended`;
      case 'declined':
        return t`Declined`;
      case 'error':
        return t`Last turn failed`;
    }
  })();

  const run = async (which: 'approve' | 'decline', fn?: () => Promise<void>) => {
    if (!fn || busy) return;
    setBusy(which);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

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
      className={cn(
        'ms-10 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border bg-background px-2.5 py-1 text-[11px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        TONE[state],
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[state], running && 'animate-pulse')} aria-hidden />
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground/70">·</span>
      <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="session-card-counts">
        <Plural value={promptCount} one="# prompt" other="# prompts" />
        {' · '}
        <Plural value={replyCount} one="# reply" other="# replies" />
      </span>
      {role === 'host' && state === 'pending' && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void run('approve', onApprove);
            }}
            disabled={!!busy}
            data-testid="session-card-approve"
            className="ms-1 rounded bg-primary px-2 py-0.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Trans>Approve</Trans>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void run('decline', onDecline);
            }}
            disabled={!!busy}
            data-testid="session-card-decline"
            className="rounded border border-border px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <Trans>Decline</Trans>
          </button>
        </>
      )}
      {/* The whole row opens the session (see the outer role="button"); this is
          just the affordance hint, not a separate control. */}
      <span data-testid="session-card-open" className="ms-auto inline-flex items-center gap-1 text-muted-foreground">
        <ExternalLink className="h-3 w-3" aria-hidden />
        <Trans>Open</Trans>
      </span>
    </div>
  );
}
