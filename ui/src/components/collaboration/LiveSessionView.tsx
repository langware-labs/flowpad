import {
  FlowMessage,
  FlowMessageKind,
  PermissionAction,
  QueryFilter,
  QueryRequest,
  RemoteWorkerSession,
  RemoteWorkerSessionStatus,
  SessionReplyPolicy,
  TypeId,
  isSessionTerminal,
} from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft, CircleCheck, CircleX, Pause, Play, PlugZap, Radio } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { MessageComposer } from '@src/components/conversation/MessageComposer';
import { SessionEventLine } from '@src/components/conversation/SessionEventLine';
import {
  grantContactPermission,
  revokeContactPermission,
  sessionGrantScope,
  useContactPermissions,
  type ContactKey,
} from '@src/hooks/use-contact-permissions';
import { useAuth, useEntitiesQuery } from '@sdk/react/hooks';
import { useEntity } from '@src/hooks/entity-hooks/useEntity';
import { truncate } from '@src/components/hooks/event-summaries';
import { LatestScroll } from '@src/components/conversation/LatestScroll';
import { useApproveLiveSession } from './useApproveLiveSession';
import {
  carriesPrompt,
  failedPromptOf,
  promptTextOf,
  resultTextOf,
  sessionEventOf,
} from '@src/components/conversation/session-turns';
import { useRetryFailedPrompt } from '@src/components/conversation/useRetryFailedPrompt';

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

/** Guest-facing status line per lifecycle state. */
function statusLine(status: string | undefined, hostName: string): ReactNode {
  switch (status) {
    case RemoteWorkerSessionStatus.DRAFT:
      return <Trans>Requesting access to {hostName}'s machine…</Trans>;
    case RemoteWorkerSessionStatus.PENDING:
      return <Trans>Waiting for {hostName} to approve the live session…</Trans>;
    case RemoteWorkerSessionStatus.RUNNING:
      return <Trans>Working on {hostName}'s machine…</Trans>;
    case RemoteWorkerSessionStatus.IDLE:
      return <Trans>Connected to {hostName}'s machine.</Trans>;
    case RemoteWorkerSessionStatus.ERROR:
      return <Trans>Connected to {hostName}'s machine — the last prompt failed.</Trans>;
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

/** Truncate the opening prompt to a one-line title. */
export function sessionTitle(prompt: string, max = 80): string {
  return truncate(prompt.trim().split('\n')[0] ?? '', max - 1);
}

/** Host-only standing grant: future sessions from this guest start approved,
 *  in this project or everywhere. Backed by ONE ContactPermission row. */
function StandingGrantCheckbox({
  contact,
  projectId,
  guestName,
}: {
  contact: ContactKey;
  projectId: string | null;
  guestName: string;
}) {
  const { t } = useLingui();
  const { permissions, refetch } = useContactPermissions(contact);
  const scope = sessionGrantScope(permissions, projectId);
  const [pendingScope, setPendingScope] = useState<'project' | 'everywhere'>(projectId ? 'project' : 'everywhere');
  const effectiveScope: 'project' | 'everywhere' = scope === 'global' ? 'everywhere' : (scope ?? pendingScope);
  const apply = useCallback(
    async (on: boolean, which: 'project' | 'everywhere') => {
      const target = which === 'project' ? projectId : null;
      // one row at a time: moving scope revokes the other first
      if (scope === 'project' && which !== 'project')
        await revokeContactPermission(contact, projectId, PermissionAction.AUTO_APPROVE_SESSION);
      if (scope === 'global' && which !== 'everywhere')
        await revokeContactPermission(contact, null, PermissionAction.AUTO_APPROVE_SESSION);
      if (on) await grantContactPermission(contact, target, PermissionAction.AUTO_APPROVE_SESSION);
      else await revokeContactPermission(contact, target, PermissionAction.AUTO_APPROVE_SESSION);
      await refetch?.();
    },
    [contact, projectId, scope, refetch],
  );
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <label className="flex cursor-pointer items-center gap-1.5">
        <Checkbox
          checked={scope !== null}
          onCheckedChange={(v) => void apply(!!v, effectiveScope)}
          className="h-3.5 w-3.5"
          data-testid="live-session-standing-grant"
        />
        <Trans>Always allow sessions from {guestName}</Trans>
      </label>
      <select
        value={effectiveScope}
        onChange={(e) => {
          const next = e.target.value as 'project' | 'everywhere';
          setPendingScope(next);
          if (scope !== null) void apply(true, next);
        }}
        aria-label={t`Standing grant scope`}
        data-testid="live-session-standing-grant-scope"
        className="rounded border border-border bg-background px-1 py-0.5 text-[11px]"
      >
        {projectId && <option value="project">{t`in this project`}</option>}
        <option value="everywhere">{t`everywhere`}</option>
      </select>
    </div>
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
  const { t } = useLingui();
  const { cloudUser } = useAuth();
  const { navigation: dockNavigation } = useDockNavigation();
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

  // The session is named after its first prompt (a session opened before any
  // prompt starts with its `requested` line, which names nothing). Memoized: the
  // scan reads every message's attachments, on a list that grows.
  const firstPrompt = useMemo(() => messages.find((m) => carriesPrompt(m)) ?? null, [messages]);

  const { approve, picker: approvePicker } = useApproveLiveSession();
  const retryFailedPrompt = useRetryFailedPrompt();
  // The prompt the host failed to run and nothing answered since — its failed line offers Retry.
  const failed = useMemo(() => failedPromptOf(messages), [messages]);
  const lastFailedLine = useMemo(
    () => [...messages].reverse().find((m) => sessionEventOf(m) === 'failed') ?? null,
    [messages],
  );

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

  // Local vs remote, from where this machine sits: the guest's prompts are local
  // to the guest and run remotely, on the host's Claude Code; the host sees both flipped.
  const otherName = isHost ? guestName : hostName;
  const promptAuthor = isHost ? guestName : t`you`;
  const replyAuthor = isHost ? t`your Claude Code` : t`${hostName}'s Claude Code`;
  const title = firstPrompt ? sessionTitle(promptTextOf(firstPrompt)) : t`Live session with ${otherName}`;

  const onSent = () => void refetch?.();

  const replyPolicyControl = (
    <Select
      value={session.effectiveReplyPolicy}
      onValueChange={(v) => void runAction('policy', () => session.setReplyPolicy(v as SessionReplyPolicy))}
      disabled={terminal || !!busy}
    >
      <SelectTrigger className="h-6 w-auto gap-1 px-2 text-[11px]" data-testid="live-session-reply-policy">
        <span className="text-muted-foreground">
          <Trans>Replies:</Trans>
        </span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SessionReplyPolicy.AUTO}>
          <Trans>Auto-send</Trans>
        </SelectItem>
        <SelectItem value={SessionReplyPolicy.REVIEW}>
          <Trans>{hostName} reviews</Trans>
        </SelectItem>
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex h-full flex-col" data-testid="live-session-view">
      {approvePicker}
      <div className="flex flex-shrink-0 items-center gap-2 border-b px-4 py-1.5">
        {conversationId && (
          <button
            type="button"
            onClick={() =>
              dockNavigation.openDock(
                DockPointer.forConversation(conversationId, { messageId: session.starting_message_id ?? null }),
              )
            }
            data-testid="live-session-back"
            title={t`Back to the conversation message that started this session`}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            <Trans>Back</Trans>
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="live-session-title" title={title}>
          {title}
        </span>
        {replyPolicyControl}
      </div>
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
                  onClick={() => void runAction('approve', () => approve(session))}
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
              <StandingGrantCheckbox
                contact={guestContact}
                projectId={session.project_id ?? null}
                guestName={guestName}
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

      {/* ── terminal-style exchange, latest-first; the composer below rides its context ── */}
      <LatestScroll
        className="bg-zinc-950/[.03] px-4 py-3 font-mono text-[12.5px] leading-relaxed dark:bg-zinc-50/[.03]"
        after={
          /* ── composer (guest drives; host may also type) ── */
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
              <div className="flex flex-col gap-1">
                <p className="text-[11px] text-muted-foreground" data-testid="live-session-input-caption">
                  {isHost ? (
                    <Trans>Runs on your machine, in your Claude Code · Enter to send</Trans>
                  ) : (
                    <Trans>Runs on {hostName}'s machine, in their Claude Code · Enter to send</Trans>
                  )}
                </p>
                <MessageComposer
                  conversationId={conversationId}
                  liveSessionId={sessionId}
                  onSent={onSent}
                  variant="terminal"
                  autoFocus
                  placeholder={
                    isHost ? t`Prompt for your Claude Code…` : t`Prompt for Claude Code on ${hostName}'s machine…`
                  }
                />
              </div>
            ) : (
              <p className="text-center text-[11px] italic text-muted-foreground/70">
                <Trans>This session has no bound conversation.</Trans>
              </p>
            )}
          </div>
        }
      >
        {messages.length === 0 ? (
          <p className="text-muted-foreground/70" data-testid="live-session-empty">
            {isHost ? (
              <Trans>No prompts yet — {guestName}'s prompts will run here, in your Claude Code.</Trans>
            ) : (
              <Trans>No prompts yet — type one below; it runs in Claude Code on {hostName}'s machine.</Trans>
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((fm) => {
              if (fm.kind === FlowMessageKind.SESSION_EVENT) {
                const retry =
                  !isHost && failed && conversationId && sessionEventOf(fm) === 'failed' && fm === lastFailedLine
                    ? () => void runAction('retry', () => retryFailedPrompt(conversationId, sessionId, failed.text))
                    : undefined;
                return (
                  <SessionEventLine key={fm.id} text={fm.text ?? ''} onRetry={retry} retrying={busy === 'retry'} />
                );
              }
              const result = resultTextOf(fm);
              if (result !== null) {
                if (fm.is_draft && isHost) {
                  // Review policy: the reply waits as the host's draft — send
                  // or discard it here, in the session, never in the thread.
                  return (
                    <div key={fm.id} className="flex flex-col gap-1" data-testid="live-session-review-draft">
                      <span className="text-[11px] italic text-muted-foreground">
                        <Trans>Reply awaiting your review</Trans>
                      </span>
                      <MessageComposer draft={fm} onSent={onSent} onAfterDiscard={onSent} />
                    </div>
                  );
                }
                return (
                  <div
                    key={fm.id}
                    data-testid="live-session-reply"
                    data-side={isHost ? 'local' : 'remote'}
                    className="flex flex-col gap-0.5 border-s-2 border-sky-500/60 ps-3"
                  >
                    <span className="select-none font-sans text-[10.5px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">
                      {replyAuthor}
                      <span className="ms-1.5 normal-case tracking-normal text-muted-foreground">
                        {isHost ? <Trans>· local</Trans> : <Trans>· remote</Trans>}
                      </span>
                    </span>
                    <pre className="whitespace-pre-wrap text-foreground/90">{result}</pre>
                  </div>
                );
              }
              const prompt = promptTextOf(fm);
              if (!prompt) return null;
              return (
                <div
                  key={fm.id}
                  className="flex gap-2"
                  data-testid="live-session-prompt"
                  data-side={isHost ? 'remote' : 'local'}
                >
                  <span className="shrink-0 select-none text-emerald-600 dark:text-emerald-400">{promptAuthor} ❯</span>
                  <pre className="whitespace-pre-wrap">{prompt}</pre>
                </div>
              );
            })}
          </div>
        )}
      </LatestScroll>
    </div>
  );
}
