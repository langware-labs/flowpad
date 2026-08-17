import {
  Conversation,
  FlowMessage,
  Invitation,
  Project,
  QueryRequest,
  Task,
  TypeId,
  acceptInvitation,
  dismissConversation,
  fetchConversations,
  isInvitationGoneError,
  isTypeId,
  latestPointer,
} from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { uploadFlowMessage, type UploadConflict } from '@sdk/entities/flow-message';
import { useEntitiesQuery, useEntity } from '@src/hooks/entity-hooks';
import { useLoginRequired, useResumeAfterLogin } from '@src/hooks/use-login-required';
import LoginDialog, { ActionType } from '@src/components/login-required-dialog';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';
import { deriveConversationTitle } from '@src/components/conversation/conversation-title';
import { ConversationParticipants } from '@src/components/conversation/ConversationParticipants';
import { participantIsUser, participantName } from '@src/components/conversation/participant-display';
import { conversationFacets, compareConversationsByRecency } from '@src/components/conversation/conversation-category';
import { CategoryChips } from '@src/components/conversation/CategoryChips';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { CheckCheck, EyeOff, MailPlus, MessageSquare, Plus, RefreshCw, Upload } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useIsAdvanced } from '@src/components/view-mode';
import { formatTimeAgo } from './project-activity-utils';
import { Trans, useLingui } from '@lingui/react/macro';

const VISIBLE_COUNT = 5;

/**
 * Extract the sender's display name from an auto-generated conversation title.
 * NewConversationDialog builds titles as "<sender>, <recipient>[, …] - <date>",
 * so the leading segment before the first comma is the conversation
 * originator. This is the only place the sender's display name is reliably
 * stored — the conversation row and its messages carry only the recipient.
 * Returns null for custom titles (no "<comma> … - <date>" shape) so callers
 * can fall back to other sender signals (wire sender_name, roster).
 */
function parseSenderFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const trimmed = title.trim();
  const comma = trimmed.indexOf(',');
  // Require both the comma and the " - " date separator so custom titles
  // ("Hello, world") aren't mistaken for the auto-generated shape.
  if (comma <= 0 || !trimmed.includes(' - ')) return null;
  return trimmed.slice(0, comma).trim() || null;
}

/**
 * Extract the participant list from an auto-generated conversation title
 * ("<sender>, <recipient>[, …] - <date>") by dropping the trailing date
 * suffix — yielding the "<sender>, <recipient>" portion. Returns null for
 * custom titles that don't follow the shape so callers can fall back.
 */
function parseParticipantsFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const trimmed = title.trim();
  const dateSep = trimmed.lastIndexOf(' - ');
  if (dateSep <= 0 || !trimmed.includes(',')) return null;
  return trimmed.slice(0, dateSep).trim() || null;
}

interface RecentConversationsStripProps {
  /** Optional cap on rows visible before "Open all" appears. Defaults to 5. */
  visibleCount?: number;
}

export function RecentConversationsStrip({ visibleCount = VISIBLE_COUNT }: RecentConversationsStripProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { checkLoginAndProceed, showLoginDialog, closeLoginDialog } = useLoginRequired();
  const isAdvanced = useIsAdvanced();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadConflicts, setUploadConflicts] = useState<UploadConflict[] | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [newConvOpen, setNewConvOpen] = useState(false);

  // Single source of truth: every row is a Conversation. Invitation rows are
  // Conversations whose first FlowMessage has ``kind === 'invitation'`` —
  // built locally by ``_ensure_invitation_placeholder_conversation`` after
  // ``fetchConversations`` materializes a pending Invitation. The Accept CTA
  // reads ``invitation_id`` off that first message's ``context_entities``.
  const request = useMemo(() => new QueryRequest({ type: Conversation.type }), []);
  const { data: conversations = [], refetch, isLoading } = useEntitiesQuery<Conversation>(request);

  const sorted = useMemo(() => {
    const list = [...conversations];
    list.sort(compareConversationsByRecency);
    return list;
  }, [conversations]);

  const [hubSyncing, setHubSyncing] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [dismissingAll, setDismissingAll] = useState(false);
  // Conv ids hidden because dismissed_at is fresh relative to their latest
  // message. Children report via onHiddenChange so the parent can drive the
  // header count + "No conversations" empty state.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const handleHiddenChange = useCallback((convId: string, hidden: boolean) => {
    setHiddenIds((prev) => {
      const has = prev.has(convId);
      if (hidden === has) return prev;
      const next = new Set(prev);
      if (hidden) next.add(convId);
      else next.delete(convId);
      return next;
    });
  }, []);

  // Filter live conversations against hiddenIds so stale ids (from removed
  // conversations) don't skew the count.
  const liveVisibleCount = sorted.reduce((acc, c) => acc + (c.id && hiddenIds.has(c.id) ? 0 : 1), 0);
  const visibleCountActual = liveVisibleCount;
  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCountActual > visibleCount;

  // "New conversation" — gated on a cloud session (same as the home landing's
  // former "Start conversation" CTA, which this footer button replaces). After
  // a forced login completes, reopen the dialog the user was reaching for.
  const handleNewConversation = () => {
    if (!checkLoginAndProceed(ActionType.START_CONVERSATION, undefined, undefined, { forceLogin: true })) return;
    setNewConvOpen(true);
  };
  useResumeAfterLogin(ActionType.START_CONVERSATION, () => setNewConvOpen(true));

  const handleRefresh = async () => {
    // Refresh pulls from the hub, which requires a cloud session. Gate on
    // login first — silently swallowing 401s here led to a confusing UX
    // where the button appeared dead. Same pattern as "Start conversation"
    // on the home landing.
    if (!checkLoginAndProceed(ActionType.REFRESH, undefined, undefined, { forceLogin: true })) return;
    setHubSyncing(true);
    try {
      try {
        await fetchConversations();
      } catch {
        // hub may be unavailable / not configured — local refetch still works
      }
      await refetch();
    } finally {
      setHubSyncing(false);
    }
  };

  const handleDismissAll = async () => {
    setDismissingAll(true);
    try {
      // Dismiss every live (non-hidden) conversation. Dismiss — not archive —
      // hides it from this list but keeps it in the full Inbox and lets it
      // reappear when a new message arrives, matching the per-row EyeOff action.
      const targets = sorted.filter((c) => c.id && !hiddenIds.has(c.id));
      await Promise.all(targets.map((c) => dismissConversation({ conversation_id: c.id })));
      void refetch();
    } finally {
      setDismissingAll(false);
    }
  };

  const handleAcceptInvitation = async (invId: string) => {
    setAcceptingId(invId);
    try {
      await acceptInvitation({ invitation_id: invId });
      await refetch();
    } catch (e) {
      if (isInvitationGoneError(e)) {
        // Orphan — the backend removed the stale local mirror; refetch drops it.
        await refetch();
      } else {
        console.error('[RecentConversationsStrip] acceptInvitation failed', e);
      }
    } finally {
      setAcceptingId(null);
    }
  };

  const handleDismissConversation = async (convId: string) => {
    setDismissingId(convId);
    try {
      await dismissConversation({ conversation_id: convId });
      await refetch();
    } catch (e) {
      console.error('[RecentConversationsStrip] dismissConversation failed', e);
    } finally {
      setDismissingId(null);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadError(null);
    setUploadConflicts(null);
    try {
      const result = await uploadFlowMessage(file);
      if (result.conversation_id) {
        navigation.openDock(DockPointer.forConversation(result.conversation_id));
      } else if (result.task_id) {
        navigation.openDock(DockPointer.forTasks(result.task_id));
      }
      void refetch();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: { data?: { conflicts?: UploadConflict[] } } } };
      if (axiosErr?.response?.status === 409) {
        setPendingFile(file);
        setUploadConflicts(axiosErr.response.data?.data?.conflicts ?? []);
      } else {
        const msg = err instanceof Error ? err.message : 'Upload failed.';
        setUploadError(msg);
      }
    }
  };

  const handleOverwrite = async () => {
    if (!pendingFile) return;
    setUploadError(null);
    try {
      const result = await uploadFlowMessage(pendingFile, { overwrite: true });
      setPendingFile(null);
      setUploadConflicts(null);
      if (result.conversation_id) {
        navigation.openDock(DockPointer.forConversation(result.conversation_id));
      } else if (result.task_id) {
        navigation.openDock(DockPointer.forTasks(result.task_id));
      }
      void refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed.';
      setUploadError(msg);
    }
  };

  return (
    <div className="flex flex-col rounded-lg border" data-testid="recent-conversations-strip">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">
            <Trans>Inbox</Trans>
          </span>
          {visibleCountActual > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {visibleCountActual}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".flowmsg"
            className="hidden"
            onChange={(e) => void handleFileChange(e)}
          />
          {/* Upload / Dismiss-all are Advanced-view only; Refresh stays in
              Standard view. New conversation lives in the footer. */}
          {isAdvanced && (
            <>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                title={t`Upload message`}
                data-testid="upload-message-button"
              >
                <Upload className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                onClick={() => void handleDismissAll()}
                disabled={dismissingAll || visibleCountActual === 0}
                title={t`Dismiss all notifications`}
                data-testid="dismiss-all-notifications-button"
              >
                <CheckCheck className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => void handleRefresh()}
            title={t`Refresh (pulls from hub)`}
            data-testid="refresh-conversations-button"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading || hubSyncing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {uploadError && <p className="px-3 pb-2 text-xs text-destructive">{uploadError}</p>}
      {uploadConflicts && (
        <div className="mx-3 mb-2 space-y-1 rounded-md border border-border bg-muted/40 p-2 text-xs">
          <p className="font-medium text-foreground">
            <Trans>Entities already exist:</Trans>
          </p>
          <p className="text-muted-foreground">{uploadConflicts.map((c) => `${c.type}:${c.id}`).join(', ')}</p>
          <div className="flex gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => void handleOverwrite()}
              className="rounded bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              <Trans>Overwrite</Trans>
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingFile(null);
                setUploadConflicts(null);
              }}
              className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
            >
              <Trans>Cancel</Trans>
            </button>
          </div>
        </div>
      )}

      <div className="pb-1">
        {visibleCountActual === 0 ? (
          <div className="px-3 pb-3 text-xs text-muted-foreground">
            <Trans>No conversations</Trans>
          </div>
        ) : (
          visible.map((conv) => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              acceptingId={acceptingId}
              dismissingId={dismissingId}
              onAcceptInvitation={(id) => void handleAcceptInvitation(id)}
              onDismiss={(id) => void handleDismissConversation(id)}
              onHiddenChange={handleHiddenChange}
            />
          ))
        )}
      </div>

      {/* Footer actions — always rendered (even with no conversations) so the
          bar stays aligned with adjacent columns. */}
      <div className="flex border-t">
        <button
          type="button"
          className="flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          onClick={handleNewConversation}
          data-testid="new-conversation-footer-button"
        >
          <Plus className="h-3.5 w-3.5" />
          <Trans>New</Trans>
        </button>
        {visibleCountActual > 0 && (
          <button
            type="button"
            className="flex flex-1 items-center justify-center gap-1.5 border-s px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => navigation.openDock(DockPointer.forInbox())}
            data-testid="open-all-conversations"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <Trans>All</Trans>
            {hasMore ? ` (${visibleCountActual})` : ''}
          </button>
        )}
      </div>

      <NewConversationDialog
        open={newConvOpen}
        onClose={() => {
          setNewConvOpen(false);
          void refetch();
        }}
      />
      <LoginDialog open={showLoginDialog} onOpenChange={closeLoginDialog} />
    </div>
  );
}

interface ConversationRowProps {
  conv: Conversation;
  acceptingId: string | null;
  dismissingId: string | null;
  onAcceptInvitation: (invitationId: string) => void;
  onDismiss: (convId: string) => void;
  onHiddenChange: (convId: string, hidden: boolean) => void;
}

function ConversationRow({
  conv,
  acceptingId,
  dismissingId,
  onAcceptInvitation,
  onDismiss,
  onHiddenChange,
}: ConversationRowProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { cloudUser, currentUser } = useAuth();
  const projectTypeId = useMemo(
    () => (conv.project_id ? new TypeId(Project.type, conv.project_id) : null),
    [conv.project_id],
  );
  const { data: project } = useEntity<Project>(projectTypeId);

  const taskTypeId = useMemo(() => conv.firstContextOfType?.('task') ?? null, [conv]);
  const { data: task } = useEntity<Task>(taskTypeId);

  // Pull both first and last message: invitation-kind rows always have one
  // message and that message IS the first one; regular conversations show the
  // latest message preview but still need the first to detect invitation kind.
  const pointers = conv.conversationMessageIds ?? [];
  const firstPtr = pointers[0];
  const lastPtr = latestPointer(pointers);

  const firstTypeId = useMemo(() => (firstPtr ? new TypeId(FlowMessage.type, firstPtr.id) : null), [firstPtr?.id]);
  const lastTypeId = useMemo(() => (lastPtr ? new TypeId(FlowMessage.type, lastPtr.id) : null), [lastPtr?.id]);
  const { data: firstMessage } = useEntity<FlowMessage>(firstTypeId);
  const { data: latestMessage } = useEntity<FlowMessage>(lastTypeId);

  const invitationTypeId = useMemo(() => firstMessage?.firstContextOfType?.('invitation') ?? null, [firstMessage]);
  const invitationId = invitationTypeId?.id ?? null;
  const { data: invitation } = useEntity<Invitation>(invitationTypeId);

  // The current user's identity — cloud email when logged in, else local.
  const myEmail = (cloudUser?.email || currentUser?.email || '').trim().toLowerCase();

  // Shared category classifier — single source of truth for invitation /
  // helpdesk / archived (replacing the per-strip copies). Invitation is
  // viewer-relative: matched on the Invitation's ``recipient_email`` so "I was
  // invited" stays distinct from "I sent this". Archived compares the latest
  // pointer ``ts`` so it auto-revives without racing the async FlowMessage fetch.
  const facets = conversationFacets({
    conv,
    firstMessage,
    latestMessage,
    latestPtrTs: lastPtr?.ts ?? null,
    invitation,
    viewer: {
      email: myEmail,
      cloudUserId: cloudUser?.id ?? null,
      localUserId: currentUser?.id ?? null,
    },
  });
  const isInvitationRow = facets.isInvitation;

  // ``dismissed_at`` is a strip-only "Hide from Recent" (EyeOff) flag — NOT part
  // of the shared category, so it stays local. Same auto-revive pattern: compare
  // the stamp against the latest pointer ``ts`` to avoid flicker during the fetch.
  const latestMessageTime = lastPtr?.ts ? new Date(lastPtr.ts).getTime() : 0;
  const dismissedAt = conv.dismissed_at ? new Date(conv.dismissed_at).getTime() : null;
  const dismissedHidden = dismissedAt !== null && !Number.isNaN(dismissedAt) && latestMessageTime <= dismissedAt;

  const hidden = dismissedHidden || facets.isArchived;
  const convIdStr = conv.id ?? '';
  // Report hidden state up so the parent can drive the header count + empty
  // state. No cleanup callback: cleanup that calls setState during unmount /
  // HMR runs synchronously inside React's deletion phase and can trigger a
  // setState→deletion→cleanup→setState cascade. Stale ids self-correct because
  // the parent computes the count by filtering against the live conv list.
  useLayoutEffect(() => {
    if (!convIdStr) return;
    onHiddenChange(convIdStr, hidden);
  }, [convIdStr, hidden, onHiddenChange]);

  if (hidden) return null;

  const messageCount = conv.message_count ?? 0;
  const projectLabel = project?.displayName ?? null;
  const taskTitle = task?.title?.trim() || null;
  // The row label is the conversation's own title (derived via the canonical
  // helper: conv.title → name → participants). A task in the conversation's
  // shared context is NOT a title source — it surfaces only as the amber task
  // chip below. Mirrors the inbox row fix.
  const derivedTitle = deriveConversationTitle(conv);
  const title = isInvitationRow ? t`Invitation` : isTypeId(derivedTitle) ? t`Conversation` : derivedTitle;
  const taskFirstWord = taskTitle ? taskTitle.split(/\s+/)[0] : null;
  // Preview text: an invitation preview's body is often just the raw
  // ``conversation-<uuid>`` typeid — never surface that; use a friendly
  // fallback instead.
  const rawPreview = isInvitationRow
    ? firstMessage?.text?.trim()
    : latestMessage?.text
        ?.trim()
        .split('\n')
        .find((l) => l.trim());
  const previewText = isTypeId(rawPreview)
    ? isInvitationRow
      ? t`You've been invited to a conversation`
      : null
    : rawPreview || (isInvitationRow ? t`You've been invited to a conversation` : null);
  // Row label. A pending invitation shows "from <sender>" so the recipient
  // sees who invited them. An accepted / ongoing conversation instead lists
  // the participants ("Alice, bob@local.test"). Both are carried by the
  // auto-generated title "<sender>, <recipient>[, …] - <date>"; custom titles
  // fall back to SENDER signals only: the invitation message's wire-stamped
  // ``sender_name``, then the non-self roster entry. NEVER ``created_by`` —
  // on receiver-materialized rows that's whoever ran the local sync (the
  // recipient), not the inviter (the "from <my git user.name>" bug).
  const titleSender = parseSenderFromTitle(conv.title);
  const wireSender = firstMessage?.sender_name?.trim() || null;
  const rosterSender = (() => {
    const me = { id: cloudUser?.id ?? currentUser?.id ?? null, email: myEmail || null };
    const other = (conv.members ?? []).find((p) => p && !participantIsUser(p, me));
    return other ? participantName(other) : null;
  })();
  const inviterName = titleSender || wireSender || rosterSender;
  const fromName = isInvitationRow
    ? inviterName
      ? `from ${inviterName}`
      : null
    : parseParticipantsFromTitle(conv.title);

  const handleClick = () => {
    if (isInvitationRow) return; // primary CTA is Accept; don't navigate
    navigation.openDock(conv.dockPointer);
  };

  return (
    <div
      className={`group flex cursor-pointer items-start justify-between gap-2 px-3 py-1.5 hover:bg-muted/50 ${
        isInvitationRow ? 'cursor-default' : ''
      }`}
      onClick={handleClick}
      data-testid="conversation-row"
      data-conversation-id={conv.id}
      data-project-id={conv.project_id ?? ''}
      data-kind={isInvitationRow ? 'invitation' : 'user'}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-1.5">
          <span className="flex items-center gap-1 truncate text-xs font-medium" data-testid="conversation-from">
            {isInvitationRow && (
              <MailPlus className="h-3 w-3 flex-shrink-0 text-violet-500" aria-label={t`invitation`} />
            )}
            <span className="truncate">{fromName ?? title}</span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <CategoryChips facets={facets} />
            {projectLabel && (
              <span
                className="inline-flex shrink-0 items-center rounded-md border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                data-testid="project-chip"
                data-chip-type="project"
                title={`Project: ${projectLabel}`}
              >
                {projectLabel}
              </span>
            )}
            {taskFirstWord && (
              <span
                className="inline-flex shrink-0 items-center rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                data-testid="task-chip"
                data-chip-type="task"
                title={`Task: ${taskTitle ?? taskFirstWord}`}
              >
                {taskFirstWord}
              </span>
            )}
          </div>
        </div>
        {previewText && (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" data-testid="conversation-preview">
            {previewText}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{formatTimeAgo(conv.updated_date)}</span>
          {!isInvitationRow && messageCount > 0 && (
            <span>
              · {messageCount} msg{messageCount === 1 ? '' : 's'}
            </span>
          )}
          {!isInvitationRow && (conv.members?.length ?? 0) > 0 && (
            <>
              <span>·</span>
              <ConversationParticipants participants={conv.members!} kind={conv.kind} />
            </>
          )}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {isInvitationRow && invitationId && (
          <button
            type="button"
            onClick={() => onAcceptInvitation(invitationId)}
            disabled={acceptingId === invitationId}
            className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="accept-invitation-button"
          >
            {acceptingId === invitationId ? t`Accepting…` : t`Accept`}
          </button>
        )}
        {conv.id && (
          <button
            type="button"
            onClick={() => onDismiss(conv.id)}
            disabled={dismissingId === conv.id}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground disabled:opacity-40 group-hover:opacity-100"
            title={t`Hide from Recent — still visible in Inbox; reappears when a new message arrives`}
            aria-label={t`Hide from Recent conversations`}
            data-testid="dismiss-conversation-button"
          >
            <EyeOff className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

export default RecentConversationsStrip;
