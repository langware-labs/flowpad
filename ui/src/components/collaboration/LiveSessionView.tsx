import {
  FlowMessage,
  FlowMessageKind,
  PermissionAction,
  QueryFilter,
  QueryRequest,
  RemoteWorkerSession,
  RemoteWorkerSessionStatus,
  TypeId,
  isSessionTerminal,
} from '@sdk';
import { Trans } from '@lingui/react/macro';
import { CircleCheck, CircleX, Pause, Play, PlugZap, Radio } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { MessageComposer } from '@src/components/conversation/MessageComposer';
import { SessionEventLine } from '@src/components/conversation/LiveSessionGroup';
import { PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT } from '@src/components/conversation/constants';
import {
  grantContactPermission,
  revokeContactPermission,
  useContactPermissions,
  type ContactKey,
} from '@src/hooks/use-contact-permissions';
import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';

/**
 * Client-side resolver seam for the live-session state: today it's the watched
 * entity row (message-borne snapshots + the host's own writes both land
 * there). The optional hub real-time channel plugs in behind this hook.
 */
export function useLiveSession(sessionId: string) {
  const sessionTypeId = useMemo(() => {
    try {
      return new TypeId(RemoteWorkerSession.type, sessionId);
    } catch {
      return null;
    }
  }, [sessionId]);
  return useEntity<RemoteWorkerSession>(sessionTypeId, { watch: true });
}

function promptTextOf(fm: FlowMessage): string {
  for (const a of fm.attachment ?? []) {
    if (a?.attachment_type === 'type_id' && (a.data ?? '').startsWith('prompt-') && a.prompt_preview) {
      return a.prompt_preview;
    }
    if (a?.attachment_type === 'prompt' && a.data && !a.data.startsWith('prompt/')) {
      return a.data;
    }
  }
  const text = fm.text ?? '';
  return text === PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT ? '' : text;
}

function resultTextOf(fm: FlowMessage): string | null {
  for (const a of fm.attachment ?? []) {
    if (a?.attachment_type === 'type_id' && (a.data ?? '').startsWith('prompt_completion-')) {
      return a.prompt_preview ?? fm.text ?? '';
    }
  }
  return null;
}

/** Guest-facing status line per lifecycle state. */
function statusLine(status: string | undefined, hostName: string): ReactNode {
  switch (status) {
    case RemoteWorkerSessionStatus.DRAFT:
      return <Trans>Not started — your first prompt will request access to {hostName}'s machine.</Trans>;
    case RemoteWorkerSessionStatus.PENDING:
      return <Trans>Waiting for {hostName} to approve the live session…</Trans>;
    case RemoteWorkerSessionStatus.RUNNING:
      return <Trans>Working on {hostName}'s machine…</Trans>;
    case RemoteWorkerSessionStatus.IDLE:
      return <Trans>Connected to {hostName}'s machine.</Trans>;
    case RemoteWorkerSessionStatus.PAUSED:
      return <Trans>{hostName} paused the live session.</Trans>;
    case RemoteWorkerSessionStatus.DECLINED:
      return <Trans>{hostName} declined the live session.</Trans>;
    case RemoteWorkerSessionStatus.ENDED:
      return <Trans>The live session has ended.</Trans>;
    default:
      return <Trans>status: {status ?? 'unknown'}</Trans>;
  }
}

/** Host permission toggle backed by a ContactPermission row. */
function PermissionToggle({
  contact,
  projectId,
  action,
  label,
}: {
  contact: ContactKey;
  projectId: string | null;
  action: PermissionAction;
  label: ReactNode;
}) {
  const { permissions, refetch } = useContactPermissions(contact);
  const granted = permissions.some(
    (r) => (r.project_id ?? null) === projectId && (r.allowed_actions ?? []).includes(action),
  );
  const toggle = useCallback(async () => {
    if (granted) await revokeContactPermission(contact, projectId, action);
    else await grantContactPermission(contact, projectId, action);
    await refetch?.();
  }, [granted, contact, projectId, action, refetch]);
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
      <Checkbox checked={granted} onCheckedChange={() => void toggle()} className="h-3.5 w-3.5" />
      {label}
    </label>
  );
}

/**
 * The live-session surface — the same Prompt/PromptCompletion FlowMessages the
 * conversation groups away, rendered as a terminal-style exchange ("I am
 * working on the other side"). The GUEST types prompts and watches; the HOST
 * gets the pinned amber control header (Approve/Decline, Pause/Resume,
 * Disconnect, standing-permission toggles).
 */
export function LiveSessionView({ sessionId }: { sessionId: string }) {
  // Host/guest ids are CLOUD ids (host_user_id is stamped from the roster /
  // sender cloud identity), so compare against cloudUser, not the local
  // bootstrap user — otherwise the host is misread as a guest.
  const { cloudUser } = useAuth();
  const { data: session, refetch } = useLiveSession(sessionId);
  const [busy, setBusy] = useState<string | null>(null);

  const conversationId = session?.conversation_id ?? null;
  const messagesRequest = useMemo(
    () =>
      new QueryRequest({
        type: FlowMessage.type,
        scope: [],
        name: `live-session:${sessionId}`,
        query: new QueryFilter({
          match: {
            op: '$AND',
            operands: [{ op: '$EQ', operands: ['remote_worker_session_id', sessionId] }],
          } as Record<string, unknown>,
          order_by: { created_date: 'asc' },
        }),
      }),
    [sessionId],
  );
  const { data: messages = [] } = useEntitiesQuery<FlowMessage>(messagesRequest, {
    enabled: !!sessionId,
  });

  const runAction = useCallback(
    async (verb: string, fn: () => Promise<void>) => {
      setBusy(verb);
      try {
        await fn();
        await refetch?.();
      } finally {
        setBusy(null);
      }
    },
    [refetch],
  );

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading live session…</Trans>
      </div>
    );
  }

  const isHost = session.isHost(cloudUser?.id ?? null) || !!session.host_process_id;
  const status = session.status;
  const terminal = isSessionTerminal(status);
  const hostName = session.host_name ?? 'the host';
  const guestName = session.guest_name ?? session.guest_user_id ?? 'the guest';
  const guestContact: ContactKey = { userId: session.guest_user_id ?? null, email: null };

  // Guest DRAFT → PENDING flips locally on the first send (host-authoritative
  // afterwards; apply_snapshot's no-regress rules protect the optimistic flip).
  const onSent = () => {
    if (!isHost && session.status === RemoteWorkerSessionStatus.DRAFT) {
      session.status = RemoteWorkerSessionStatus.PENDING;
      void session.save();
    }
    void refetch?.();
  };

  return (
    <div className="flex h-full flex-col" data-testid="live-session-view">
      {/* ── pinned header ─────────────────────────────────────────────── */}
      {isHost ? (
        <div className="sticky top-0 z-10 flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2">
          <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <Radio className="h-4 w-4 flex-shrink-0" />
            <span>
              {status === RemoteWorkerSessionStatus.PENDING ? (
                <Trans>{guestName} wants to run prompts on your machine.</Trans>
              ) : (
                <Trans>
                  Live session with {guestName} on your machine · {status}
                </Trans>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {status === RemoteWorkerSessionStatus.PENDING && (
              <>
                <Button
                  size="sm"
                  onClick={() => void runAction('approve', () => session.approve())}
                  disabled={!!busy}
                  data-testid="live-session-approve"
                >
                  <CircleCheck className="me-1.5 h-4 w-4" />
                  <Trans>Approve</Trans>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runAction('decline', () => session.decline())}
                  disabled={!!busy}
                  data-testid="live-session-decline"
                >
                  <CircleX className="me-1.5 h-4 w-4" />
                  <Trans>Decline</Trans>
                </Button>
              </>
            )}
            {(status === RemoteWorkerSessionStatus.IDLE || status === RemoteWorkerSessionStatus.RUNNING) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runAction('pause', () => session.pause())}
                disabled={!!busy}
                data-testid="live-session-pause"
              >
                <Pause className="me-1.5 h-4 w-4" />
                <Trans>Pause</Trans>
              </Button>
            )}
            {status === RemoteWorkerSessionStatus.PAUSED && (
              <Button
                size="sm"
                onClick={() => void runAction('resume', () => session.resume())}
                disabled={!!busy}
                data-testid="live-session-resume"
              >
                <Play className="me-1.5 h-4 w-4" />
                <Trans>Resume</Trans>
              </Button>
            )}
            {!terminal && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void runAction('disconnect', () => session.disconnect())}
                disabled={!!busy}
                data-testid="live-session-disconnect"
              >
                <PlugZap className="me-1.5 h-4 w-4" />
                <Trans>Disconnect</Trans>
              </Button>
            )}
          </div>
          {!terminal && (
            <div className="flex w-full items-center gap-4">
              <PermissionToggle
                contact={guestContact}
                projectId={session.project_id ?? null}
                action={PermissionAction.EXECUTE_PROMPT}
                label={<Trans>Always auto-run {guestName}'s sessions here</Trans>}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="sticky top-0 z-10 flex flex-shrink-0 items-center gap-2 border-b bg-background px-4 py-2 text-xs text-muted-foreground">
          <Radio
            className={`h-3.5 w-3.5 flex-shrink-0 ${status === RemoteWorkerSessionStatus.RUNNING ? 'animate-pulse text-emerald-500' : ''}`}
          />
          <span data-testid="live-session-status-line">{statusLine(status, hostName)}</span>
        </div>
      )}

      {/* ── terminal-style exchange ───────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-950/[.03] px-4 py-3 font-mono text-[12.5px] leading-relaxed dark:bg-zinc-50/[.03]">
        {messages.length === 0 ? (
          <p className="text-muted-foreground/70">
            <Trans>No turns yet — send a prompt below to start working on {hostName}'s machine.</Trans>
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((fm) => {
              if (fm.kind === FlowMessageKind.SESSION_EVENT) {
                return <SessionEventLine key={fm.id} text={fm.text ?? ''} />;
              }
              const result = resultTextOf(fm);
              if (result !== null) {
                return (
                  <pre key={fm.id} className="whitespace-pre-wrap text-foreground/90">
                    {result}
                  </pre>
                );
              }
              const prompt = promptTextOf(fm);
              if (!prompt) return null;
              return (
                <div key={fm.id} className="flex gap-2">
                  <span className="select-none text-emerald-600 dark:text-emerald-400">❯</span>
                  <pre className="whitespace-pre-wrap">{prompt}</pre>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── composer (guest drives; host may also type) ───────────────── */}
      <div className="flex-shrink-0 border-t px-3 py-2">
        {terminal ? (
          <p className="text-center text-[11px] italic text-muted-foreground/70">
            {status === RemoteWorkerSessionStatus.DECLINED ? (
              <Trans>This live session was declined.</Trans>
            ) : (
              <Trans>This live session has ended.</Trans>
            )}
          </p>
        ) : conversationId ? (
          <MessageComposer conversationId={conversationId} liveSessionId={sessionId} onSent={onSent} />
        ) : (
          <p className="text-center text-[11px] italic text-muted-foreground/70">
            <Trans>This session has no bound conversation.</Trans>
          </p>
        )}
      </div>
    </div>
  );
}
