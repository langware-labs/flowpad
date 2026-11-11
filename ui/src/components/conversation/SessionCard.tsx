import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState, type ReactNode } from 'react';
import { RemoteWorkerSession, RemoteWorkerSessionStatus, SessionReplyPolicy } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { formatClock } from '@src/components/lens-viewer/shared/format-utils';
import { useClock } from '@src/hooks/useActivity';
import { cn } from '@src/lib/utils';
import { GuestPermissionChip, HostApprovalChip } from '@src/components/collaboration/GuestPermissionChip';
import { SessionRoleBadge } from '@src/components/collaboration/SessionRoleBadge';
import { OpenSessionChatButton } from './LiveSessionActivity';
import { sessionCardState, sessionExpiresAt, type SessionCardState } from './session-card-state';
import { sessionTitle } from './session-turns';

export interface SessionCardProps {
  sessionId: string;
  /** null while the row has not synced → "requesting". */
  session: RemoteWorkerSession | null;
  role: 'host' | 'guest' | 'observer';
  promptCount: number;
  replyCount: number;
  /** URL-first: the caller navigates (`openDock(DockPointer.forLiveSession)`). */
  onOpen: () => void;
  /** Host + pending only: approve this live session only. */
  onApprove?: () => Promise<void>;
  onDecline?: () => Promise<void>;
  /** Either side, while live: end the session. */
  onDisconnect?: () => Promise<void>;
  /** The session's last prompt failed and nothing answered it since. */
  lastPromptFailed?: boolean;
  /** Guest only: send the failed prompt again into this session. */
  onRetry?: () => Promise<void>;
  /** The session's last prompt while nothing answered it — named on the line while it runs. */
  runningPrompt?: string | null;
  /** Host only: the chat the session's prompts run in (its Claude Code process). */
  chatProcessId?: string | null;
  /** Prompt request, host + pending: run it — `auto` sends the answer back (Run & Update),
   *  `review` keeps it here (Run). */
  onRun?: (replyPolicy: SessionReplyPolicy) => Promise<void>;
  /** Prompt request: the answer the host sent back, once it arrived. */
  resultText?: string | null;
}

const TONE: Record<SessionCardState, string> = {
  requesting: 'text-muted-foreground',
  pending: 'text-amber-700 dark:text-amber-300',
  active: 'text-emerald-700 dark:text-emerald-300',
  ended: 'text-muted-foreground',
  declined: 'text-red-700 dark:text-red-300',
};

const DOT: Record<SessionCardState, string> = {
  requesting: 'bg-muted-foreground',
  pending: 'bg-amber-500',
  active: 'bg-emerald-500',
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
 * The host answers a request here once (Approve or Decline); once it is live the
 * line carries the message count, the time since approval, and a red Disconnect.
 * The guest can cancel a request the host has not answered yet.
 * While a prompt runs the line names it; the host also gets an icon that opens
 * the chat it runs in.
 */
export function SessionCard({
  sessionId,
  session,
  role,
  promptCount,
  replyCount,
  onOpen,
  onApprove,
  onDecline,
  onDisconnect,
  lastPromptFailed,
  onRetry,
  runningPrompt,
  chatProcessId,
  onRun,
  resultText,
}: SessionCardProps) {
  const { t } = useLingui();
  const [busy, setBusy] = useState<
    'approve' | 'decline' | 'disconnect' | 'retry' | 'run-update' | 'run' | 'open' | null
  >(null);
  // Past the length cap the session is over on this side too, whatever the row says.
  const expired = useSessionExpired(session);
  const state = expired ? 'ended' : sessionCardState(session?.status);
  // While a prompt runs the line names it — its first line — instead of a bare "working…".
  // A prompt with no reply yet is being worked on. Read from the messages, not the
  // status alone: the guest's mirror learns status only from snapshots riding a
  // message, and nothing is sent when a turn starts, so it never reads RUNNING.
  // The line truncates with CSS; the cap only keeps a huge prompt out of the DOM.
  const promptLine = state === 'active' && runningPrompt ? sessionTitle(runningPrompt, 200) : '';
  const running = state === 'active' && (session?.status === RemoteWorkerSessionStatus.RUNNING || !!promptLine);
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

  // The one clickable line both kinds share; each kind fills in its own words and actions.
  const row = (kind: 'live' | 'prompt-request', shown: string, title: string, children: ReactNode) => (
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
      data-kind={kind}
      data-session-id={sessionId}
      data-status={shown}
      title={title}
      className="flex w-full max-w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {children}
    </div>
  );

  if (session?.isPromptRequest) {
    // A prompt request: ONE prompt on the host's machine, then the host ends it.
    // Same line, its own words — no session clock, no counts, no permission chip.
    const done = state === 'ended' && session.prompts_used > 0;
    const shown = done ? 'active' : state;
    const promptStatus = (() => {
      if (state === 'requesting') return role === 'host' ? t`requested` : t`sending…`;
      if (state === 'pending') return role === 'host' ? t`not run yet` : t`waiting for ${other}`;
      if (state === 'active') return running ? t`running` : t`starting…`;
      if (state === 'declined') return t`declined`;
      return done ? t`done` : t`cancelled`;
    })();
    const secondary = 'border border-border text-foreground hover:bg-muted';
    return (
      <div className="flex flex-col gap-0.5">
        {row(
          'prompt-request',
          done ? 'done' : state,
          t`Open the prompt's run`,
          <>
            <span
              className="max-w-[16rem] shrink-0 truncate font-medium text-foreground"
              data-testid="session-card-name"
            >
              <Trans>Prompt request · {other}</Trans>
            </span>
            <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[shown], running && 'animate-pulse')} aria-hidden />
            <span className={cn('shrink-0', TONE[shown])} data-testid="session-card-status">
              {promptStatus}
            </span>
            {state === 'active' && session.approved_at && <SinceApproved approvedAt={session.approved_at} />}
            {failedLive && (
              <span className="shrink-0 font-medium text-red-700 dark:text-red-300" data-testid="session-card-failed">
                <Trans>Failed</Trans>
              </span>
            )}
            <span className="ms-auto flex shrink-0 items-center gap-1.5">
              {failedLive && button('retry', onRetry, secondary, <Trans>Retry</Trans>)}
              {answering && onRun && (
                <>
                  {button(
                    'run-update',
                    () => onRun(SessionReplyPolicy.AUTO),
                    'bg-blue-600 text-white hover:bg-blue-500',
                    <Trans>Run &amp; Update {guest}</Trans>,
                  )}
                  {button('run', () => onRun(SessionReplyPolicy.REVIEW), secondary, <Trans>Run</Trans>)}
                </>
              )}
              {answering && button('decline', onDecline, secondary, <Trans>Decline</Trans>)}
              {(state === 'active' || done) && button('open', async () => onOpen(), secondary, <Trans>Open</Trans>)}
              {((role === 'guest' && (state === 'pending' || state === 'requesting')) || state === 'active') &&
                button('disconnect', onDisconnect, secondary, <Trans>Cancel</Trans>)}
            </span>
          </>,
        )}
        {done && role === 'host' && session.effectiveReplyPolicy === SessionReplyPolicy.AUTO && (
          <span className="px-2 text-xs text-emerald-700 dark:text-emerald-300" data-testid="session-card-update-sent">
            <Trans>✓ Update sent to {guest}</Trans>
          </span>
        )}
        {role === 'guest' && resultText && (
          <div
            className="me-2 ms-6 max-w-2xl rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm"
            data-testid="session-card-update"
          >
            <span className="block text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              <Trans>Update from {host}</Trans>
            </span>
            <span className="whitespace-pre-wrap text-foreground/90">{resultText}</span>
          </div>
        )}
      </div>
    );
  }

  return row(
    'live',
    state,
    t`Open the live session`,
    <>
      <span className="max-w-[16rem] shrink-0 truncate font-medium text-foreground" data-testid="session-card-name">
        <Trans>Live session · {other}</Trans>
      </span>
      <SessionRoleBadge role={role} />
      <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[state], running && 'animate-pulse')} aria-hidden />
      {promptLine ? (
        <span
          className={cn('min-w-0 truncate font-mono', TONE[state])}
          data-testid="session-card-prompt"
          title={runningPrompt ?? undefined}
        >
          ❯ {promptLine}
        </span>
      ) : (
        <span className={cn('shrink-0', TONE[state])} data-testid="session-card-status">
          {status}
        </span>
      )}
      {state === 'active' && (
        <>
          <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="session-card-counts">
            <Plural value={promptCount + replyCount} one="# message" other="# messages" />
          </span>
          {session?.approved_at && <SinceApproved approvedAt={session.approved_at} />}
        </>
      )}
      {role === 'host' && session && (state === 'active' || state === 'pending') && (
        <GuestPermissionChip
          guestName={guest}
          pending={state === 'pending'}
          onApprove={() => void run('approve', onApprove)}
          disabled={!!busy}
        />
      )}
      {role === 'guest' && session && (state === 'active' || state === 'pending') && (
        <HostApprovalChip hostName={host} pending={state === 'pending'} />
      )}
      {failedLive && (
        <span className="shrink-0 font-medium text-red-700 dark:text-red-300" data-testid="session-card-failed">
          <Trans>Last prompt failed</Trans>
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1.5">
        {chatProcessId && state === 'active' && <OpenSessionChatButton processId={chatProcessId} />}
        {failedLive &&
          button('retry', onRetry, 'border border-border text-foreground hover:bg-muted', <Trans>Retry</Trans>)}
        {answering && (
          <>
            {button('approve', onApprove, 'bg-blue-600 text-white hover:bg-blue-500', <Trans>Approve</Trans>)}
            {button(
              'decline',
              onDecline,
              'border border-border text-foreground hover:bg-muted',
              <Trans>Decline</Trans>,
            )}
          </>
        )}
        {role === 'guest' &&
          (state === 'pending' || state === 'requesting') &&
          button(
            'disconnect',
            onDisconnect,
            'border border-border text-foreground hover:bg-muted',
            <Trans>Cancel request</Trans>,
          )}
        {state === 'active' &&
          button(
            'disconnect',
            onDisconnect,
            'bg-destructive text-destructive-foreground hover:bg-destructive/90',
            <Trans>Disconnect</Trans>,
          )}
      </span>
    </>,
  );
}
