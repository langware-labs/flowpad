import { FlowMessage, GitRepo, TypeId, User } from '@sdk';
import { isValidIdentifier } from '@sdk/models/TypeId';
import { useEntity } from '@sdk/react/hooks';
import { useEffect, useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage, ConversationParticipant } from '@sdk/entities/conversation';
import { BodyStatus } from '@sdk/entities/flow-message';
import { AlertCircle, Download, Loader2, X } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { AttachmentChip, AttachmentChipState } from './AttachmentChip';
import { ContextEntityChip } from './EntityChip';
import { GitRepoChip } from '@src/components/git/GitRepoChip';
import { useLocalUser } from './useLocalUser';
import { localBundleUrl } from './flow-message-drafts';
import { MessageComposer } from './MessageComposer';
import {
  participantLabelByUserId,
  UNRESOLVED_SENDER_LABEL,
  warnUnresolvedSender,
} from './participant-display';
import { useAttachments } from './useAttachments';
import { editorPathForLocalFile } from './attachment-url';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { cn } from '@src/lib/utils';

/** Single Download affordance for a message whose body bundle hasn't been
 *  pulled yet. One click materializes every attachment (files + entities) —
 *  they all ride in one bundle. Badge shows the asset count; the tooltip lists
 *  the typeids + filenames it will fetch. */
function DownloadAttachmentsButton({
  count,
  labels,
  uploading,
  downloading,
  onDownload,
}: {
  count: number;
  labels: string[];
  uploading: boolean;
  downloading: boolean;
  onDownload: () => void;
}) {
  const disabled = uploading || downloading;
  const sub = uploading
    ? 'Uploading…'
    : downloading
      ? 'Downloading…'
      : `Download ${count} ${count === 1 ? 'attachment' : 'attachments'}`;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onDownload}
      title={labels.length ? labels.join('\n') : 'Download attachments'}
      className={cn(
        'flex w-full max-w-[360px] items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 text-left transition-colors',
        uploading
          ? 'cursor-not-allowed border-border bg-background opacity-50'
          : downloading
            ? 'cursor-default border-primary/60 bg-background'
            : 'cursor-pointer border-primary/60 bg-background hover:bg-muted/40',
      )}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
        {downloading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {count} {count === 1 ? 'asset' : 'assets'} attached
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{sub}</span>
      </div>
    </button>
  );
}


interface FlowMessageBubbleProps {
  messageId: string;
  /** The FlowMessage entity, supplied by the parent's batched conversation
   *  query (one request for all messages, replacing the per-bubble fetch).
   *  When omitted the bubble falls back to fetching by id. */
  fm?: FlowMessage | null;
  timestamp: string;
  task?: ITask | null;
  onApproveAndExecute?: (messageId: string, attachmentIndex: number) => void;
  /** Per-message Implement Plan handler. The bubble itself decides whether to
   *  render the chip (spec present + recipient role) — pass the raw messageId
   *  callback and the bubble binds it. */
  onImplementPlan?: (messageId: string) => void;
  /** When a plan-implementation session already exists for this conversation
   *  (or is in-flight), the bubble shows an "Open Plan Implementation Session"
   *  link instead of the Implement Plan chip. */
  onOpenPlanSession?: () => void;
  /** Open the spec's markdown in an editable Milkdown view. The bubble looks
   *  up its own Spec TypeId and calls back with the id. */
  onViewPlan?: (specId: string) => void;
  /** Render the bubble as a local draft — replaces the message view with the
   *  MessageComposer in draft mode (always-editable, attach File/Asset/Repo,
   *  Send/Discard). */
  isDraft?: boolean;
  /** Called after the draft was sent or discarded so the parent can refetch. */
  onDraftSent?: () => void;
  /** Drives the visual selection ring + Context drawer tab. */
  isSelected?: boolean;
  /** Click on the bubble fires this so the parent can mark this message selected. */
  onSelect?: () => void;
  /** True when the local user owns the parent conversation (created_by). The
   *  conversation owner may delete ANY message; everyone may delete their own.
   *  Together with `isCurrentUser` this gates the delete affordance. */
  isConversationOwner?: boolean;
  /** Delete this message everywhere. The bubble only wires it through when the
   *  local user is allowed (sender of this message OR conversation owner). */
  onDeleteMessage?: (messageId: string) => void;
  participants?: ConversationParticipant[];
  /** True once the parent has resolved the canonical hub roster (success
   *  OR explicit failure). The bubble only escalates to the UNRESOLVED
   *  alert label when `rosterReady` is true — otherwise it falls through
   *  to the soft cushions (sender_name, creator, 'unknown') so legitimate
   *  load windows don't flash the alert glyph. */
  rosterReady?: boolean;
  /** Parent conversation's `message_status_visible` flag — passed straight
   *  through to the receipt indicator. Defaults to true. */
  conversationStatusVisible?: boolean;
  /** Project gate from the parent. Attachment downloads materialize assets into
   *  the conversation's project (`.claude/…`), so a download must run inside a
   *  mapped project — when supplied, the bubble routes its download trigger
   *  through this, which opens the project picker first if none is selected and
   *  resumes the download after a pick. */
  ensureProjectMapped?: (run: () => void | Promise<void>) => void;
}

export function FlowMessageBubble({
  messageId,
  fm: fmProp,
  timestamp,
  task,
  onApproveAndExecute,
  onImplementPlan,
  onOpenPlanSession,
  onViewPlan,
  isDraft,
  onDraftSent,
  isSelected,
  onSelect,
  isConversationOwner = false,
  onDeleteMessage,
  participants,
  rosterReady = false,
  conversationStatusVisible = true,
  ensureProjectMapped,
}: FlowMessageBubbleProps) {
  // Prefer the FlowMessage handed down from the parent's batched conversation
  // query; fall back to a per-id fetch only when it wasn't provided (so the
  // bubble still works in isolation). Passing null to useEntity disables the
  // fetch — the same pattern the creator lookup below uses.
  const { data: fetchedFm } = useEntity<FlowMessage>(
    fmProp ? null : new TypeId(FlowMessage.type, messageId),
  );
  const fm = fmProp ?? fetchedFm;
  // Resolve the message author via `created_by`. Used as the sender-name
  // fallback for messages that carry no `sender_id`/`sender_name` — notably
  // the invitation-kind placeholder, whose author is the inviter.
  // `created_by` can be a non-entity sentinel (e.g. "system") for hub-authored
  // messages — guard so the TypeId constructor doesn't throw on those.
  const { data: creator } = useEntity<User>(
    fm?.created_by && isValidIdentifier(fm.created_by)
      ? new TypeId(User.type, fm.created_by)
      : null,
  );
  const { localUser, updateName } = useLocalUser();
  const { navigation } = useDockNavigation();
  const [overrideName, setOverrideName] = useState<string | null>(null);
  // The single attachment surface: per-file chip state + url, the live progress
  // bar, the per-message download-error slot, and the one download entrypoint.
  // Replaces the inline chipState / bundle-chip / handleDownloadBody wiring.
  const {
    items: attachmentItems,
    entities,
    downloaded,
    assetCount,
    assetLabels,
    progress,
    error: downloadError,
    dismissError: dismissDownloadError,
    downloading,
    download: handleDownloadBody,
  } = useAttachments(fm, messageId);

  // Unresolved-sender telemetry. Hoisted ABOVE the early returns so the hook
  // count is identical on every render (a useEffect after ``if (!fm) return``
  // / ``if (isDraft) return`` would run only on some renders → React's
  // "Rendered more hooks than during the previous render" crash). The body is
  // guarded: it fires only once ``fm`` exists, it's not a draft, the label
  // resolved to the alert sentinel, and the roster has actually loaded.
  // ``displayName`` is computed further below; recompute the alert condition
  // here from the same inputs so this can live before that code.
  const unresolvedSenderId =
    fm && !isDraft && fm.sender_id && rosterReady
      && !participantLabelByUserId(participants, fm.sender_id)
      && !(localUser?.id && fm.sender_id === localUser.id)
      && !(fm.sender_name?.trim())
      && !(creator?.name?.trim() || creator?.email?.trim())
      ? fm.sender_id
      : null;
  useEffect(() => {
    if (!unresolvedSenderId) return;
    warnUnresolvedSender(
      unresolvedSenderId,
      fm?.conversation_id ?? null,
      participants?.length ?? 0,
    );
  }, [unresolvedSenderId, fm?.conversation_id, participants?.length]);

  if (!fm) {
    // The pointer to this FlowMessage is in the conversation.jsonl, but the
    // entity itself hasn't been materialised locally yet (it lands via the
    // hub bundle, which is fetched asynchronously). Show a thin placeholder
    // instead of returning null so the bubble doesn't disappear silently.
    return (
      <div className="flex gap-2 opacity-60">
        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
          <span className="text-[11px] italic text-muted-foreground/70">Loading message…</span>
        </div>
      </div>
    );
  }

  if (isDraft) {
    return (
      <MessageComposer
        draft={fm}
        conversationId={fm.conversation_id ?? undefined}
        onSent={onDraftSent}
        onAfterDiscard={onDraftSent}
      />
    );
  }

  const isCurrentUser = !!(fm.sender_id && localUser?.id && fm.sender_id === localUser.id);
  const creatorLabel = creator?.name?.trim() || creator?.email?.trim() || null;
  // Identity is hub-authoritative — but the bubble must NOT flash the alert
  // glyph on legitimate gaps (cold-load before roster fetch returns,
  // departed members, cross-instance bundle imports). Tiered chain:
  //   1. local self-edit override (always wins)
  //   2. roster lookup by sender_id (canonical hub-authoritative label)
  //   3. it's me → my local profile name
  //   4. wire-stamped sender_name — soft cushion only; legitimate for
  //      messages from senders who left the roster or are on a different
  //      instance (bundle import). Not trusted as identity but better than
  //      blank for users.
  //   5. creator entity name (for invitation placeholders, system msgs)
  //   6a. UNRESOLVED — ONLY when sender_id is set AND the roster has
  //      confirmed loaded (rosterReady) AND none of the cushions matched.
  //      That's the "the hub roster says no, no other signal" case worth
  //      alerting on.
  //   6b. otherwise the benign 'unknown' string (roster still loading, no
  //      sender_id at all, etc.)
  const rosterLabel = fm.sender_id
    ? participantLabelByUserId(participants, fm.sender_id)
    : null;
  const wireSenderName = fm.sender_name?.trim() || null;
  let displayName: string;
  if (overrideName) {
    displayName = overrideName;
  } else if (rosterLabel) {
    displayName = rosterLabel;
  } else if (isCurrentUser) {
    displayName = localUser?.name?.trim() || 'You';
  } else if (wireSenderName) {
    displayName = wireSenderName;
  } else if (creatorLabel) {
    displayName = creatorLabel;
  } else if (fm.sender_id && rosterReady) {
    displayName = UNRESOLVED_SENDER_LABEL;
  } else {
    displayName = 'unknown';
  }

  // Telemetry: warn once per (conv, sender_id) when we landed on the alert
  // label — the warn lives in an effect (NOT the render body) so re-renders
  // don't flood devtools. NOTE: the ``useEffect`` itself is hoisted ABOVE the
  // early returns (``if (!fm)`` / ``if (isDraft)``) — see near the other hooks
  // — because a hook called after a conditional return changes the per-render
  // hook count and trips React's "Rendered more hooks than during the previous
  // render". Here we only derive the boolean it keys on.
  const isAlertLabel = displayName === UNRESOLVED_SENDER_LABEL;

  // When task is present, role tracks the original task initiator (sender) vs
  // recipient. For project-scoped conversations (no task), use the local user
  // as the "sender" perspective.
  const role: 'sender' | 'recipient' = task
    ? fm.sender_id && task.shared_by_id && fm.sender_id === task.shared_by_id
      ? 'sender'
      : 'recipient'
    : isCurrentUser
    ? 'sender'
    : 'recipient';

  // The invitation-kind placeholder stores the target conversation's TypeId
  // in `text` (the hub reuses Invitation.message as a conv-id pointer). That
  // string is plumbing, not a message — never render it as bubble content.
  const isConvIdPointer = !!fm.conversation_id
    && fm.text === `conversation-${fm.conversation_id}`;
  const message: ConversationMessage = {
    role,
    content: isConvIdPointer ? '' : (fm.text ?? ''),
    sender_id: fm.sender_id ?? '',
    timestamp,
  };

  // Files + entities (Skill / Markdown / Spec / git_repo) come from the single
  // `useAttachments` surface, along with the message-level `downloaded` flag.
  // `git_repo` is a remote reference rendered via its own accept-and-work modal
  // (no bundle download), so it's split out and always shown; the rest ride in
  // the body bundle and only render as live chips once `downloaded`.
  const gitRepoEntities = entities.filter((t) => t.type === GitRepo.type);
  const otherEntities = entities.filter((t) => t.type !== GitRepo.type);
  const hasAttachments = attachmentItems.length > 0 || entities.length > 0;
  const bodyStatus = fm.body_status ?? BodyStatus.NA;
  const hasBody = bodyStatus !== BodyStatus.NA;

  // One click pulls the whole bundle (files + entities). When the parent supplies
  // a project gate, route through it: assets materialize into the conversation's
  // project, so a download with no project selected opens the picker first and
  // resumes after a pick.
  const triggerDownload = () =>
    ensureProjectMapped
      ? ensureProjectMapped(() => handleDownloadBody())
      : void handleDownloadBody();

  const progressPct =
    progress && progress.bytesTotal > 0 ? Math.round(progress.fraction * 100) : null;

  const footer = hasAttachments || downloadError ? (
    <div className="mt-2 space-y-1.5">
      {downloadError && (
        <div
          className="flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/10 px-2 py-1.5 text-[11px] text-orange-700 dark:text-orange-300"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Could not download</div>
            <div className="break-all text-[10px] text-orange-700/80 dark:text-orange-300/80">
              {downloadError.method} {downloadError.path} {downloadError.statusCode}
              : {downloadError.message}
            </div>
          </div>
          <button
            type="button"
            onClick={dismissDownloadError}
            className="shrink-0 rounded p-0.5 text-orange-700/70 hover:bg-orange-500/20 hover:text-orange-700 dark:text-orange-300/70 dark:hover:text-orange-200"
            title="Dismiss"
            aria-label="Dismiss download error"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {progress && (
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full bg-primary transition-all',
                progressPct === null && 'animate-pulse',
              )}
              style={{ width: progressPct === null ? '100%' : `${progressPct}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {progress.phase === 'upload' ? 'Uploading' : 'Downloading'}
            {progressPct === null ? '…' : ` ${progressPct}%`}
          </span>
        </div>
      )}
      {/* git_repo references open the accept-and-work modal directly — no
          bundle download needed, so they render in both states. */}
      {gitRepoEntities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {gitRepoEntities.map((typeId) => (
            <GitRepoChip key={`asset:${typeId.type}-${typeId.id}`} typeId={typeId} />
          ))}
        </div>
      )}
      {downloaded ? (
        <>
          {otherEntities.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {otherEntities.map((typeId) => (
                <ContextEntityChip
                  key={`asset:${typeId.type}-${typeId.id}`}
                  typeId={typeId}
                  inside={{ type: 'conversation', id: fm.conversation_id ?? '' }}
                />
              ))}
            </div>
          )}
          {attachmentItems.map((item) => (
            <AttachmentChip
              key={item.key}
              url={item.url ?? ''}
              filename={item.filename}
              state={item.state}
              downloading={item.state === AttachmentChipState.Ready && downloading}
              onDownload={
                item.state === AttachmentChipState.Ready ? triggerDownload : undefined
              }
              onOpenInEditor={
                item.localPath
                  ? () => navigation.openEditor(editorPathForLocalFile(item.localPath!))
                  : undefined
              }
              onRevealInFolder={
                item.localPath
                  ? () => void openExternalFromComputeNode('@local', item.localPath!, { select: true })
                  : undefined
              }
            />
          ))}
          {attachmentItems.length > 1 && (
            <a
              href={localBundleUrl(messageId)}
              download
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="h-3 w-3" />
              Download all attachments
            </a>
          )}
        </>
      ) : hasBody && assetCount > 0 ? (
        <DownloadAttachmentsButton
          count={assetCount}
          labels={assetLabels}
          uploading={bodyStatus === BodyStatus.UPLOADING}
          downloading={downloading}
          onDownload={triggerDownload}
        />
      ) : null}
    </div>
  ) : null;

  return (
    <MessageBubble
      message={message}
      flowMessageId={messageId}
      flowMessage={fm}
      task={task ?? undefined}
      senderName={displayName}
      onEditName={isCurrentUser ? (newName) => {
        setOverrideName(newName);
        void updateName(newName);
      } : undefined}
      onDeleteMessage={
        onDeleteMessage && (isCurrentUser || isConversationOwner)
          ? () => onDeleteMessage(messageId)
          : undefined
      }
      onApproveAndExecute={onApproveAndExecute ? (idx) => onApproveAndExecute(messageId, idx) : undefined}
      onImplementPlan={onImplementPlan ? () => onImplementPlan(messageId) : undefined}
      onOpenPlanSession={onOpenPlanSession}
      onViewPlan={onViewPlan}
      footer={footer}
      isSelected={isSelected}
      onSelect={onSelect}
      conversationStatusVisible={conversationStatusVisible}
    />
  );
}
