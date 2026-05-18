import { Conversation, FlowMessage, TypeId, User } from '@sdk';
import { isValidIdentifier } from '@sdk/models/TypeId';
import { useEntity } from '@sdk/react/hooks';
import { useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage, ConversationParticipant } from '@sdk/entities/conversation';
import {
  AttachmentType,
  BodyStatus,
  BODY_FILENAME,
  attachmentDataString,
  downloadFlowMessageUrl,
  downloadFlowMessageBody,
} from '@sdk/entities/flow-message';
import { Download } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { AttachmentChip, AttachmentChipState } from './AttachmentChip';
import { ContextEntityChip } from './EntityChip';
import { fileAttachmentUrl } from './attachment-url';
import { useLocalUser } from './useLocalUser';
import { localBundleUrl } from './flow-message-drafts';
import { DraftMessageComposer } from './DraftMessageComposer';
import { participantLabelByUserId } from './participant-display';
import { useFlowMessageProgress } from './useFlowMessageProgress';
import { cn } from '@src/lib/utils';


interface FlowMessageBubbleProps {
  messageId: string;
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
   *  DraftMessageComposer (always-editable, attachment picker, Send/Discard). */
  isDraft?: boolean;
  /** Called after the draft was sent or discarded so the parent can refetch. */
  onDraftSent?: () => void;
  /** Drives the visual selection ring + Context drawer tab. */
  isSelected?: boolean;
  /** Click on the bubble fires this so the parent can mark this message selected. */
  onSelect?: () => void;
  participants?: ConversationParticipant[];
  /** Parent conversation's `message_status_visible` flag — passed straight
   *  through to the receipt indicator. Defaults to true. */
  conversationStatusVisible?: boolean;
}

export function FlowMessageBubble({
  messageId,
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
  participants,
  conversationStatusVisible = true,
}: FlowMessageBubbleProps) {
  const { data: fm } = useEntity<FlowMessage>(
    new TypeId(FlowMessage.type, messageId),
  );
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
  const [overrideName, setOverrideName] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Live body upload/download bar — null when no transfer is in flight.
  const progress = useFlowMessageProgress(messageId);

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
      <DraftMessageComposer
        fm={fm}
        task={task}
        conversationId={fm.conversation_id ?? undefined}
        onAfterSend={onDraftSent}
        onAfterDiscard={onDraftSent}
      />
    );
  }

  const isCurrentUser = !!(fm.sender_id && localUser?.id && fm.sender_id === localUser.id);
  const creatorLabel = creator?.name?.trim() || creator?.email?.trim() || null;
  const displayName = overrideName
    ?? participantLabelByUserId(participants, fm.sender_id)
    ?? fm.sender_name
    ?? (isCurrentUser ? (localUser?.name || 'You') : null)
    ?? creatorLabel
    ?? 'unknown';

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

  // Filter out the conversation.jsonl transcript — that lives on the toolbar now.
  // ``attachmentDataString`` collapses the hub's two ``data`` shapes
  // (string ``"<type>-<id>"`` OR object ``{type, id}``) into one string.
  const fileAttachments = (fm.attachment ?? []).filter((a) => {
    if (a.attachment_type !== AttachmentType.FILE) return false;
    const d = attachmentDataString(a);
    return !!d && !d.endsWith('conversation.jsonl');
  });

  // TYPE_ID attachments (Spec, Skill, Task, AgenticProcess, …) render as
  // interactive entity chips below the bubble text — same EntityChip
  // component the conversation toolbar + ContextPanel use.
  const typeIdAttachments = (fm.attachment ?? [])
    .filter((a) => a.attachment_type === AttachmentType.TYPE_ID)
    .map((a) => {
      const d = attachmentDataString(a);
      const dash = d.indexOf('-');
      if (dash <= 0) return null;
      return new TypeId(d.slice(0, dash), d.slice(dash + 1));
    })
    .filter((t): t is TypeId => t !== null);

  // Per-message context_entities — the "private context" axis: TypeIds
  // pinned only on this row (not the whole conv). De-duped against the
  // TYPE_ID attachment row so we don't render the same chip twice.
  const attachmentChipKeys = new Set(typeIdAttachments.map((t) => `${t.type}-${t.id}`));
  // A PROMPT attachment carries its source conversation + FlowMessage in
  // context_entities as provenance. Those are implicit (the message already
  // lives inside that conversation) and just clutter the chip row, so drop
  // conversation / flow_message chips on prompt messages.
  const hasPromptAttachment = (fm.attachment ?? []).some(
    (a) => a.attachment_type === AttachmentType.PROMPT,
  );
  const contextChips: TypeId[] = (fm.contextEntities ?? []).filter((t) => {
    if (!t || !t.type || !t.id) return false;
    if (hasPromptAttachment && (t.type === Conversation.type || t.type === FlowMessage.type)) {
      return false;
    }
    return !attachmentChipKeys.has(`${t.type}-${t.id}`);
  });

  const insideConv = { type: Conversation.type, id: fm.conversation_id ?? '' };

  // Body-bundle lifecycle drives each FILE chip's appearance:
  //   uploading  — sender still staging the body (body_status=uploading)
  //   ready      — body on the hub, not yet on this machine (no local_path)
  //   downloaded — bytes are local (local_path set) or no body round-trip (na)
  const bodyStatus = fm.body_status ?? BodyStatus.NA;
  const chipState = (att: { local_path?: string | null }): AttachmentChipState => {
    if (bodyStatus === BodyStatus.UPLOADING) return AttachmentChipState.Uploading;
    if (att.local_path) return AttachmentChipState.Downloaded;
    if (bodyStatus === BodyStatus.READY) return AttachmentChipState.Ready;
    return AttachmentChipState.Downloaded;
  };
  const handleDownloadBody = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadFlowMessageBody(messageId);
      // Success fans an entity UPDATE — useEntity re-renders the chips as
      // DOWNLOADED. On failure they stay READY so the user can retry.
    } catch {
      /* swallowed — chip stays READY */
    } finally {
      setDownloading(false);
    }
  };
  // The body.flowmsg bundle is transport, not a user-facing file — never chip it.
  const showBundleChip =
    !!fm.attachment_filename && fm.attachment_filename !== BODY_FILENAME;

  const hasAttachments =
    showBundleChip
    || fileAttachments.length > 0
    || typeIdAttachments.length > 0
    || contextChips.length > 0;
  const totalAttachments = (showBundleChip ? 1 : 0) + fileAttachments.length;

  const progressPct =
    progress && progress.bytesTotal > 0 ? Math.round(progress.fraction * 100) : null;

  const footer = hasAttachments ? (
    <div className="mt-2 space-y-1.5">
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
      {(typeIdAttachments.length > 0 || contextChips.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {typeIdAttachments.map((typeId) => (
            <ContextEntityChip
              key={`att:${typeId.type}-${typeId.id}`}
              typeId={typeId}
              inside={insideConv}
            />
          ))}
          {contextChips.map((typeId) => (
            <ContextEntityChip
              key={`ctx:${typeId.type}-${typeId.id}`}
              typeId={typeId}
              inside={insideConv}
            />
          ))}
        </div>
      )}
      {showBundleChip && (
        <AttachmentChip
          url={downloadFlowMessageUrl(messageId, fm.attachment_filename!)}
          filename={fm.attachment_filename!}
        />
      )}
      {fileAttachments.map((a) => {
        const d = attachmentDataString(a);
        const name = d.split('/').pop() || d;
        const st = chipState(a);
        return (
          <AttachmentChip
            key={d}
            url={fileAttachmentUrl(messageId, d)}
            filename={name}
            state={st}
            downloading={st === AttachmentChipState.Ready && downloading}
            onDownload={st === AttachmentChipState.Ready ? () => void handleDownloadBody() : undefined}
          />
        );
      })}
      {totalAttachments > 1 && (
        <a
          href={localBundleUrl(messageId)}
          download
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Download className="h-3 w-3" />
          Download all attachments
        </a>
      )}
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
