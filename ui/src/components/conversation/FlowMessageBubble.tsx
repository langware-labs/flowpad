import { FlowMessage, GitRepo, TypeId, User } from '@sdk';
import { isValidIdentifier } from '@sdk/models/TypeId';
import { useEntity } from '@sdk/react/hooks';
import { useEffect, useState } from 'react';
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
import { AlertCircle, Download, X } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { AttachmentChip, AttachmentChipState } from './AttachmentChip';
import { ContextEntityChip } from './EntityChip';
import { GitRepoChip } from '@src/components/git/GitRepoChip';
import { fileAttachmentUrl } from './attachment-url';
import { useLocalUser } from './useLocalUser';
import { localBundleUrl } from './flow-message-drafts';
import { DraftMessageComposer } from './DraftMessageComposer';
import {
  participantLabelByUserId,
  UNRESOLVED_SENDER_LABEL,
  warnUnresolvedSender,
} from './participant-display';
import { useFlowMessageProgress } from './useFlowMessageProgress';
import { useFlowMessageDownloadError } from './useFlowMessageDownloadError';
import { cn } from '@src/lib/utils';

/** Attachment TypeId types the conversation send path injects as structural
 *  self-references — the parent conversation, the message itself, and the
 *  bound task. They are plumbing, not user-attached assets, so they never
 *  render as asset chips. */
const STRUCTURAL_ATTACHMENT_TYPES = new Set(['conversation', 'flow_message', 'task']);


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
   *  DraftMessageComposer (always-editable, attachment picker, Send/Discard). */
  isDraft?: boolean;
  /** Called after the draft was sent or discarded so the parent can refetch. */
  onDraftSent?: () => void;
  /** Drives the visual selection ring + Context drawer tab. */
  isSelected?: boolean;
  /** Click on the bubble fires this so the parent can mark this message selected. */
  onSelect?: () => void;
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
  participants,
  rosterReady = false,
  conversationStatusVisible = true,
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
  const [overrideName, setOverrideName] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Live body upload/download bar — null when no transfer is in flight.
  const progress = useFlowMessageProgress(messageId);
  // Per-message download failure — surfaced inline so the user can tell
  // *which* bubble produced the error in the warnings popover.
  const { error: downloadError, dismiss: dismissDownloadError } =
    useFlowMessageDownloadError(messageId);

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
        conversationId={fm.conversation_id ?? undefined}
        onAfterSend={onDraftSent}
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
  // don't flood devtools.
  const isAlertLabel = displayName === UNRESOLVED_SENDER_LABEL;
  useEffect(() => {
    if (!isAlertLabel || !fm.sender_id) return;
    warnUnresolvedSender(
      fm.sender_id,
      fm.conversation_id ?? null,
      participants?.length ?? 0,
    );
  }, [isAlertLabel, fm.sender_id, fm.conversation_id, participants?.length]);

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

  // Asset attachments — TYPE_ID attachments the user deliberately attached
  // (Skill, Spec, …). Rendered as clickable chips that open the entity in its
  // own view, exactly like the conversation Context panel. The structural
  // self-refs the send path injects are plumbing, so they are filtered out.
  const assetAttachments = (fm.attachment ?? [])
    .filter((a) => a.attachment_type === AttachmentType.TYPE_ID)
    .map((a) => {
      const d = attachmentDataString(a);
      const dash = d.indexOf('-');
      if (dash <= 0) return null;
      return new TypeId(d.slice(0, dash), d.slice(dash + 1));
    })
    .filter((t): t is TypeId => t !== null && !STRUCTURAL_ATTACHMENT_TYPES.has(t.type));

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
    || assetAttachments.length > 0;
  const totalAttachments = (showBundleChip ? 1 : 0) + fileAttachments.length;

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
      {assetAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {assetAttachments.map((typeId) => {
            // ``git_repo`` chips open the accept-and-work modal directly
            // (clone / checkout / pull against the recipient's project),
            // bypassing the generic dock-pointer route.
            if (typeId.type === GitRepo.type) {
              return (
                <GitRepoChip key={`asset:${typeId.type}-${typeId.id}`} typeId={typeId} />
              );
            }
            // No hintPath wired here: asset attachments are TYPE_ID
            // pointers on the FlowMessage, but the corresponding path
            // sidecar is harvested on the AgenticProcess (see
            // flow_sdk/transcript_analyzer/{plan,file}_cross_link.py).
            // Looking it up on `fm` would always return undefined.
            // Closing this gap requires either harvesting on the FM too
            // or looking up via the AP — separate follow-up.
            return (
              <ContextEntityChip
                key={`asset:${typeId.type}-${typeId.id}`}
                typeId={typeId}
                inside={{ type: 'conversation', id: fm.conversation_id ?? '' }}
              />
            );
          })}
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
