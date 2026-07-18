import {
  APIEntity,
  Artifact,
  createConversationForShare,
  dataContext,
  dataManager,
  FlowMessage,
  gitOriginCloneUrl,
  isImagePath,
  launchWizard,
  MessageAttachment,
  Prompt,
  Task,
  TypeId,
  User,
  type AgenticProcess,
  type GitOrigin,
  type WorkerStatus,
} from '@sdk';
import { isValidIdentifier } from '@sdk/models/TypeId';
import { useEntity } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage, ConversationParticipant } from '@sdk/entities/conversation';
import { BodyStatus, FlowMessageKind, forwardMessage } from '@sdk/entities/flow-message';
import { AlertCircle, Download, File, FileText, Loader2, Play, X } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { MessageContextButton } from './MessageContextButton';
import { MessageRunStatus } from './MessageRunStatus';
import { PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT } from './constants';
import { AttachmentChip, AttachmentChipState } from './AttachmentChip';
import { ContextEntityChip, EntityChip, iconForEntity } from './EntityChip';
import { chipStateFor } from './useMessageAttachments';
import { AssetReviewDialog } from './asset-review/AssetReviewDialog';
import { TESTABLE_TYPES } from './asset-review/test-prompt';
import { useRunSkillWithProjectPrompt } from './asset-review/useRunReceivedSkill';
import { useLocalUser } from './useLocalUser';
import { localBundleUrl } from './flow-message-drafts';
import { MessageComposer } from './MessageComposer';
import { participantLabelByUserId, UNRESOLVED_SENDER_LABEL, warnUnresolvedSender } from './participant-display';
import { useAttachments, type AttachmentTypeChipView } from './useAttachments';
import { dockPointerForLocalFile } from './attachment-url';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { messageForwardShareSource } from '@src/hooks/share-sources';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import type { SendTarget } from '@src/hooks/use-send-to-conversation';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { cn } from '@src/lib/utils';
import { openArtifact } from '@src/components/artifacts/open-artifact';

/** Single Download affordance for a message whose body bundle hasn't been
 *  pulled yet. One click materializes every attachment (files + entities) —
 *  they all ride in one bundle. Badge shows the asset count; the tooltip lists
 *  the typeids + filenames it will fetch. */
export function DownloadAttachmentsButton({
  count,
  labels,
  typeChips,
  uploading,
  downloading,
  onDownload,
}: {
  count: number;
  labels: string[];
  typeChips: AttachmentTypeChipView[];
  uploading: boolean;
  downloading: boolean;
  onDownload: () => void;
}) {
  const { t } = useLingui();
  const disabled = uploading || downloading;
  const sub = uploading
    ? t('Uploading…')
    : downloading
      ? t('Downloading…')
      : t`Download ${count} ${count === 1 ? 'attachment' : 'attachments'}`;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onDownload}
      data-testid="download-attachments-button"
      title={labels.length ? labels.join('\n') : t('Download attachments')}
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
          <Trans>
            {count} {count === 1 ? 'asset' : 'assets'} attached
          </Trans>
        </span>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{sub}</span>
        {typeChips.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1" aria-label={t('Attached asset types')}>
            {typeChips.map((chip) => {
              const Icon = chip.type === 'file' ? File : iconForEntity(chip.type);
              return (
                <span
                  key={chip.key}
                  data-testid={`download-asset-type-chip-${chip.type}`}
                  className="inline-flex h-5 max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 px-2 text-[10px] font-medium leading-none text-muted-foreground"
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{chip.label}</span>
                  {chip.count > 1 && <span className="tabular-nums">x{chip.count}</span>}
                </span>
              );
            })}
          </span>
        )}
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
  /** The conversation's headless run + its live status, resolved once by the
   *  parent and shared across bubbles. Drive the per-message run-status
   *  one-liner that replaces "Execute" once the prompt is executed. */
  run?: AgenticProcess | null;
  runStatus?: WorkerStatus | null;
  /** Open this message's executed run in the conversation drawer's Runs tab. */
  onOpenRun?: (processId: string) => void;
  /** Whether the conversation already has a worker session — flips the Execute
   *  chip from "Run" to "<Host>'s session · new run", resolved once by the parent. */
  workerSessionExists?: boolean;
  workerSessionLabel?: string | null;
  workerSessionInFlight?: boolean;
  /** Additive: open the conversation's worker session in the collaboration room
   *  view. Rendered as an icon on the run-status line; leaves the Runs drawer
   *  path untouched. */
  onOpenWorkerSession?: () => void;
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
  /** True when the parent conversation is a community (support-center) ticket.
   *  Staff replies are masked to a single brand identity and the real
   *  responder's `sender_id` is intentionally absent from the guest's roster,
   *  so we suppress the unresolved-sender alert and its telemetry. */
  isCommunity?: boolean;
  /** Parent conversation's `message_status_visible` flag — passed straight
   *  through to the receipt indicator. Defaults to true. */
  conversationStatusVisible?: boolean;
  /** Project shell to use when opening asset entity attachments. */
  attachmentProjectId?: string | null;
  /** Staged MessageAttachment rows for THIS message (parent-resolved via the
   *  conversation-wide query). Drive the dashed staged chips + review modal. */
  messageAttachments?: MessageAttachment[];
}

export function FlowMessageBubble({
  messageId,
  fm: fmProp,
  timestamp,
  task,
  onApproveAndExecute,
  run,
  runStatus,
  onOpenRun,
  workerSessionExists = false,
  workerSessionLabel = null,
  workerSessionInFlight = false,
  onOpenWorkerSession,
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
  isCommunity = false,
  conversationStatusVisible = true,
  attachmentProjectId,
  messageAttachments,
}: FlowMessageBubbleProps) {
  // Prefer the FlowMessage handed down from the parent's batched conversation
  // query; fall back to a per-id fetch only when it wasn't provided (so the
  // bubble still works in isolation). Passing null to useEntity disables the
  // fetch — the same pattern the creator lookup below uses.
  const { data: fetchedFm } = useEntity<FlowMessage>(fmProp ? null : new TypeId(FlowMessage.type, messageId));
  const fm = fmProp ?? fetchedFm;
  // Resolve the message author via `created_by`. Used as the sender-name
  // fallback for messages that carry no `sender_id`/`sender_name` — notably
  // the invitation-kind placeholder, whose author is the inviter.
  // `created_by` can be a non-entity sentinel (e.g. "system") for hub-authored
  // messages — guard so the TypeId constructor doesn't throw on those.
  const { data: creator } = useEntity<User>(
    fm?.created_by && isValidIdentifier(fm.created_by) ? new TypeId(User.type, fm.created_by) : null,
  );
  const { localUser, updateName } = useLocalUser();
  const { t } = useLingui();
  // `created_by` on receiver-materialized rows is whoever ran the local sync
  // (the recipient), not the author. A creator that resolves to the LOCAL
  // user on a message the local user didn't send is exactly that artifact —
  // never a sender signal, so the creator cushion must not surface it (it
  // rendered received messages as authored by the recipient's own profile
  // name, e.g. the local git user.name).
  const creatorIsLocalArtifact = !!(
    creator?.id &&
    localUser?.id &&
    creator.id === localUser.id &&
    fm?.sender_id !== localUser.id
  );
  const { navigation } = useDockNavigation();
  const [overrideName, setOverrideName] = useState<string | null>(null);
  // The single attachment surface: per-file chip state + url, the live progress
  // bar, the per-message download-error slot, and the one download entrypoint.
  // Replaces the inline chipState / bundle-chip / handleDownloadBody wiring.
  const {
    items: attachmentItems,
    entities,
    downloaded,
    sharesTranscript,
    hasPrompt,
    assetCount,
    assetLabels,
    assetTypeChips,
    progress,
    error: downloadError,
    dismissError: dismissDownloadError,
    downloading,
    download: handleDownloadBody,
  } = useAttachments(fm, messageId);

  // Hoisted above the early returns (hook count — see the telemetry note below).
  // A group parent whose member task is attached to this same message is
  // context, not the ask: it ships, but its chip is suppressed.
  const parentTaskIds = useAttachedParentTaskIds(entities);

  // Forward-to-another-conversation. Hoisted above the early returns (hook
  // count). The dialog's `commit` override POSTs the backend forward action —
  // the backend clones the message (cloned_from_id provenance, copied
  // attachment bytes) — instead of the default add_message send.
  const ensureCloudLogin = useCloudLoginGate();
  const [forwardOpen, setForwardOpen] = useState(false);
  const forwardSource = useMemo(() => {
    if (!forwardOpen || !fm) return null;
    const firstLine = (fm.text ?? '').trim().split('\n')[0]?.slice(0, 60);
    return messageForwardShareSource({ label: firstLine || 'Message' });
  }, [forwardOpen, fm]);
  const commitForward = useCallback(
    async (target: SendTarget) => {
      const convId =
        target.kind === 'existing'
          ? target.conversationId
          : (await createConversationForShare(target.params, { ensureCloudLogin })).conversation_id;
      await forwardMessage(messageId, convId);
      return convId;
    },
    [messageId, ensureCloudLogin],
  );

  // Unresolved-sender telemetry. Hoisted ABOVE the early returns so the hook
  // count is identical on every render (a useEffect after ``if (!fm) return``
  // / ``if (isDraft) return`` would run only on some renders → React's
  // "Rendered more hooks than during the previous render" crash). The body is
  // guarded: it fires only once ``fm`` exists, it's not a draft, the label
  // resolved to the alert sentinel, and the roster has actually loaded.
  // ``displayName`` is computed further below; recompute the alert condition
  // here from the same inputs so this can live before that code.
  const unresolvedSenderId =
    fm &&
    !isDraft &&
    !isCommunity &&
    fm.sender_id &&
    rosterReady &&
    !participantLabelByUserId(participants, fm.sender_id) &&
    !(localUser?.id && fm.sender_id === localUser.id) &&
    !fm.sender_name?.trim() &&
    (creatorIsLocalArtifact || !(creator?.name?.trim() || creator?.email?.trim()))
      ? fm.sender_id
      : null;
  useEffect(() => {
    if (!unresolvedSenderId) return;
    warnUnresolvedSender(unresolvedSenderId, fm?.conversation_id ?? null, participants?.length ?? 0);
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
          <span className="text-[11px] italic text-muted-foreground/70">
            <Trans>Loading message…</Trans>
          </span>
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
  const creatorLabel = creatorIsLocalArtifact ? null : creator?.name?.trim() || creator?.email?.trim() || null;
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
  const rosterLabel = fm.sender_id ? participantLabelByUserId(participants, fm.sender_id) : null;
  const wireSenderName = fm.sender_name?.trim() || null;
  let displayName: string;
  if (overrideName) {
    displayName = overrideName;
  } else if (rosterLabel) {
    displayName = rosterLabel;
  } else if (isCurrentUser) {
    displayName = localUser?.name?.trim() || t('You');
  } else if (wireSenderName) {
    displayName = wireSenderName;
  } else if (creatorLabel) {
    displayName = creatorLabel;
  } else if (fm.sender_id && rosterReady && !isCommunity) {
    displayName = UNRESOLVED_SENDER_LABEL;
  } else {
    displayName = t('unknown');
  }

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
  const isConvIdPointer = !!fm.conversation_id && fm.text === `conversation-${fm.conversation_id}`;
  const message: ConversationMessage = {
    role,
    content: isConvIdPointer ? '' : (fm.text ?? ''),
    sender_id: fm.sender_id ?? '',
    timestamp,
  };

  // Files + entities (Skill / Markdown / Spec) come from the single
  // `useAttachments` surface, along with the message-level `downloaded` flag.
  // `prompt` entities render via the attachment-actions row's
  // PromptAttachmentPreview (inside MessageBubble), not as generic chips; the
  // rest ride in the body bundle and only render as live chips once `downloaded`.
  // Prompt entities render in the attachment-actions row; a group parent whose
  // member task is attached here renders not at all (`parentTaskIds`, above).
  const otherEntities = entities.filter(
    (t) => t.type !== Prompt.type && !(t.type === Task.type && parentTaskIds.has(String(t.id))),
  );
  const hasAttachments = attachmentItems.length > 0 || entities.length > 0;
  const bodyStatus = fm.body_status ?? BodyStatus.NA;
  const hasBody = bodyStatus !== BodyStatus.NA;

  // A transcript-only share renders a fully blank bubble without this note:
  // the backend synthesizes the "Please run the following prompt:" placeholder
  // for any empty-text send (MessageBubble suppresses it, assuming a prompt
  // row takes its place), the conversation.jsonl transcript is deliberately
  // NOT a chip (it lives in the Context tab), and the structural TYPE_ID
  // self-refs are filtered too. When the message carries a transcript but no
  // prompt and no renderable chips, say what was shared instead of nothing.
  const isBareTranscriptShare =
    sharesTranscript &&
    !hasPrompt &&
    !hasAttachments &&
    (!message.content || message.content === PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT);

  // One click pulls the whole bundle (files + entities). Downloads STAGE into
  // the message's record-data dir — no project mapping needed; installing into
  // a project is the review modal's explicit step.
  const triggerDownload = () => void handleDownloadBody();

  // Image attachments whose bytes are already local render as image cards right
  // away — viewing or downloading a picture needs no project context, so they
  // skip staging entirely (the backend never stages image/video files). This is
  // what the sender sees the instant they send (their bytes are already on
  // disk): the picture itself, not a "Download" button.
  const localImageItems = attachmentItems.filter(
    (i) => i.state === AttachmentChipState.Downloaded && !!i.url && isImagePath(i.filename),
  );
  // Staged/installed RAW FILE chips (the OS-file-picker lane). A received file
  // is staged as a MessageAttachment (asset_type='file') and rides the same
  // download→review→install lifecycle as asset entities — no project gate:
  // review/install resolve their own target. Images never get a staged row.
  const fileAttachments = (messageAttachments ?? []).filter((ma) => ma.asset_type === 'file');
  const stagedFileNames = new Set(fileAttachments.map((ma) => ma.name ?? ''));
  // The SENDER's own downloaded files have no staged MA row (staging happens on
  // receive/unpack). Render them ungated so the sender sees their file
  // immediately — open/reveal work off the local path, no project needed.
  const senderLocalFileItems = attachmentItems.filter(
    (i) =>
      i.state === AttachmentChipState.Downloaded && !localImageItems.includes(i) && !stagedFileNames.has(i.filename),
  );
  // The "Download N" button must not re-count what's already surfaced without a
  // download: images shown inline above, and prompt entities (previewed in the
  // prompt row, materialized on Approve & Execute).
  const promptEntityCount = entities.filter((t) => t.type === Prompt.type).length;
  const pendingAssetCount = assetCount - localImageItems.length - promptEntityCount;

  const progressPct = progress && progress.bytesTotal > 0 ? Math.round(progress.fraction * 100) : null;

  const attachmentFooter =
    hasAttachments || downloadError || isBareTranscriptShare ? (
      <div className="mt-2 space-y-1.5">
        {isBareTranscriptShare && (
          <div className="flex items-center gap-1.5 text-[11px] italic text-muted-foreground">
            <FileText className="h-3 w-3 shrink-0" />
            <Trans>Shared a session transcript — see the Context tab</Trans>
          </div>
        )}
        {downloadError && (
          <div
            className="flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/10 px-2 py-1.5 text-[11px] text-orange-700 dark:text-orange-300"
            role="alert"
          >
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                <Trans>Could not download</Trans>
              </div>
              <div className="break-all text-[10px] text-orange-700/80 dark:text-orange-300/80">
                {downloadError.method} {downloadError.path} {downloadError.statusCode}: {downloadError.message}
              </div>
            </div>
            <button
              type="button"
              onClick={dismissDownloadError}
              className="shrink-0 rounded p-0.5 text-orange-700/70 hover:bg-orange-500/20 hover:text-orange-700 dark:text-orange-300/70 dark:hover:text-orange-200"
              title={t('Dismiss')}
              aria-label={t('Dismiss download error')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {progress && (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full bg-primary transition-all', progressPct === null && 'animate-pulse')}
                style={{ width: progressPct === null ? '100%' : `${progressPct}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              <Trans>{progress.phase === 'upload' ? 'Uploading' : 'Downloading'}</Trans>
              {progressPct === null ? '…' : ` ${progressPct}%`}
            </span>
          </div>
        )}
        {/* Locally-available images always render as image cards — no project
            gate, no download step. The sender sees them immediately. */}
        {localImageItems.map((item) => (
          <AttachmentChip
            key={item.key}
            url={item.url ?? ''}
            filename={item.filename}
            state={item.state}
            onOpenInEditor={
              item.localPath ? () => navigation.openDock(dockPointerForLocalFile(item.localPath!)) : undefined
            }
            onRevealInFolder={
              item.localPath
                ? () => void openExternalFromComputeNode('@local', item.localPath!, { select: true })
                : undefined
            }
          />
        ))}
        {/* Entity chips render as soon as the entity resolves locally — no
            body-download/login round-trip for a same-machine forward (the
            entity is already on disk). A not-yet-local (cross-user) entity stays
            hidden until the bundle is downloaded (`forceShow`), where the
            DownloadAttachmentsButton below still drives materialization. */}
        {otherEntities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {otherEntities.map((typeId) => (
              <MessageEntityChip
                key={`asset:${typeId.type}-${typeId.id}`}
                typeId={typeId}
                conversationId={fm.conversation_id ?? ''}
                projectId={attachmentProjectId}
                // Entity chips need no project context: staged chips open the
                // review modal, installed chips navigate by TypeId. `downloaded`
                // alone unhides them (file chips keep the project gate).
                forceShow={downloaded}
                attachment={messageAttachments?.find(
                  (ma) => ma.asset_type === typeId.type && ma.asset_id === String(typeId.id),
                )}
              />
            ))}
          </div>
        )}
        {/* Received raw files: dashed staged chip → review modal → install
            (solid). No project gate — the review modal resolves the target. */}
        {fileAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {fileAttachments.map((ma) => (
              <MessageFileChip key={`file:${ma.id}`} attachment={ma} projectId={attachmentProjectId} />
            ))}
          </div>
        )}
        {/* Sender's own local files (no staged row): open/reveal off local_path. */}
        {senderLocalFileItems.map((item) => (
          <AttachmentChip
            key={item.key}
            url={item.url ?? ''}
            filename={item.filename}
            state={item.state}
            onOpenInEditor={
              item.localPath ? () => navigation.openDock(dockPointerForLocalFile(item.localPath!)) : undefined
            }
            onRevealInFolder={
              item.localPath
                ? () => void openExternalFromComputeNode('@local', item.localPath!, { select: true })
                : undefined
            }
          />
        ))}
        {senderLocalFileItems.length > 1 && (
          <a
            href={localBundleUrl(messageId)}
            download
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3 w-3" />
            <Trans>Download all attachments</Trans>
          </a>
        )}
        {/* Download button ONLY while bytes are still remote. Once downloaded,
            files render as staged chips above and entities as chips — nothing
            left to pull, so no project-less dead-end button (the SAPAK bug). */}
        {hasBody && !downloaded && pendingAssetCount > 0 ? (
          <DownloadAttachmentsButton
            count={pendingAssetCount}
            labels={assetLabels}
            typeChips={assetTypeChips}
            uploading={bodyStatus === BodyStatus.UPLOADING}
            downloading={downloading}
            onDownload={triggerDownload}
          />
        ) : null}
      </div>
    ) : null;

  // The attachment block (when present) + the per-message context-process control
  // (self-gates to advanced mode; renders nothing otherwise — empty fragment is
  // inert in MessageBubble's inline `{footer}` slot).
  const footer = (
    <>
      {attachmentFooter}
      <MessageRunStatus
        fm={fm}
        run={run ?? null}
        runStatus={runStatus}
        onOpenRun={onOpenRun}
        onOpenWorkerSession={onOpenWorkerSession}
        workerSessionInFlight={workerSessionInFlight}
      />
      <MessageContextButton fm={fm} projectId={attachmentProjectId} />
    </>
  );

  const canForward = !fm.is_draft && fm.kind !== FlowMessageKind.INVITATION && !!fm.conversation_id;

  return (
    <>
      <MessageBubble
        message={message}
        flowMessageId={messageId}
        flowMessage={fm}
        task={task ?? undefined}
        senderName={displayName}
        onEditName={
          isCurrentUser
            ? (newName) => {
                setOverrideName(newName);
                void updateName(newName);
              }
            : undefined
        }
        onDeleteMessage={
          onDeleteMessage && (isCurrentUser || isConversationOwner) ? () => onDeleteMessage(messageId) : undefined
        }
        onForwardMessage={canForward ? () => setForwardOpen(true) : undefined}
        onApproveAndExecute={onApproveAndExecute ? (idx) => onApproveAndExecute(messageId, idx) : undefined}
        onImplementPlan={onImplementPlan ? () => onImplementPlan(messageId) : undefined}
        onOpenPlanSession={onOpenPlanSession}
        onViewPlan={onViewPlan}
        workerSessionExists={workerSessionExists}
        workerSessionLabel={workerSessionLabel}
        workerSessionInFlight={workerSessionInFlight}
        footer={footer}
        isSelected={isSelected}
        onSelect={onSelect}
        conversationStatusVisible={conversationStatusVisible}
      />
      {forwardOpen && forwardSource && (
        <ShareToConversationDialog
          open={forwardOpen}
          onClose={() => setForwardOpen(false)}
          source={forwardSource}
          commit={commitForward}
        />
      )}
    </>
  );
}

/**
 * A conversation entity chip that appears as soon as the referenced entity is
 * resolvable locally — no body-download / cloud-login round-trip. A local app
 * entity (e.g. a forwarded `flowpad_diagnosis`) already lives on disk, so its
 * chip shows immediately rather than as a blank message behind a Download button.
 *
 * Three-phase reception states (see useMessageAttachments.chipStateFor):
 *   installed — the entity resolves locally: today's solid chip (navigates).
 *   staged    — no local entity but a MessageAttachment row exists: dashed,
 *               clickable — opens the review/install modal (no navigation).
 *   hidden    — pre-download (`forceShow` false); the Download button carries it.
 */
/**
 * A staged/installed RAW FILE attachment (asset_type='file' — the OS-file-picker
 * lane). Unlike entity chips, a file never resolves to an entity: installed-ness
 * comes from the MA row's scope. Renders as a dashed File chip (staged) or solid
 * File chip (installed); clicking opens the review modal (install / uninstall +
 * content preview live there), matching the entity-chip flow.
 */
function MessageFileChip({ attachment, projectId }: { attachment: MessageAttachment; projectId?: string | null }) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const typeId = new TypeId('file', String(attachment.asset_id ?? ''));
  return (
    <>
      <EntityChip
        entity={{
          typeId,
          type: 'file',
          id: String(attachment.asset_id ?? ''),
          name: attachment.name ?? 'file',
          icon: File,
        }}
        staged={!attachment.installed}
        onClick={() => setReviewOpen(true)}
      />
      {reviewOpen && (
        <AssetReviewDialog
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          attachment={attachment}
          targetTypeId={typeId}
          attachmentProjectId={projectId ?? null}
        />
      )}
    </>
  );
}

/**
 * Ids of attached tasks that are the PARENT of another task attached to the
 * SAME message — their chips are suppressed.
 *
 * An assignment message carries the member's own task AND its group parent:
 * both must ride as real attachments (only attachments are packed into the body
 * bundle, so context-only sharing would strand the parent as an unresolvable
 * reference — see `useTaskAssignmentMessage`). But the message is a request to
 * do the CHILD's work; the parent is context, reachable via the child's
 * `parent_id` and the conversation's context row. So it ships, but doesn't
 * clutter the bubble.
 *
 * Only ever hides a parent whose child is attached here too — a task sent on
 * its own always renders. Resolution is async and self-correcting: until the
 * child's row is local (pre-download) nothing is hidden, and the parent chip
 * drops out once it resolves.
 */
function useAttachedParentTaskIds(entities: TypeId[]): Set<string> {
  const taskIds = useMemo(() => entities.filter((t) => t.type === Task.type).map((t) => String(t.id)), [entities]);
  const key = taskIds.join(',');
  const [parentIds, setParentIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    // A lone task has no sibling to be the parent OF — nothing to hide.
    if (taskIds.length < 2) {
      setParentIds(new Set());
      return;
    }
    let cancelled = false;
    void Promise.all(
      taskIds.map((id) => dataManager.getByTypeId<Task>(new TypeId(Task.type, id)).catch(() => null)),
    ).then((tasks) => {
      if (cancelled) return;
      const attached = new Set(taskIds);
      const parents = new Set<string>();
      for (const t of tasks) {
        // Only suppress a parent that is itself attached to this message.
        if (t?.parent_id && attached.has(t.parent_id)) parents.add(t.parent_id);
      }
      setParentIds(parents);
    });
    return () => {
      cancelled = true;
    };
    // `key` is the stable identity of `taskIds` (order-preserving join).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return parentIds;
}

function MessageEntityChip({
  typeId,
  conversationId,
  projectId,
  forceShow,
  attachment,
}: {
  typeId: TypeId;
  conversationId: string;
  projectId?: string | null;
  forceShow: boolean;
  attachment?: MessageAttachment;
}) {
  const { navigation } = useDockNavigation();
  const { start: startSkillRun, picker: runPicker } = useRunSkillWithProjectPrompt();
  const [reviewOpen, setReviewOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useEntity<APIEntity<any>>(typeId);
  const state = chipStateFor(!!data, attachment, forceShow);
  if (state === 'hidden') return null;
  // Git-link chip: a git context folder shared through push-notify. The chip
  // carries only the repo origin (no bytes); clicking launches the
  // git-context-folder wizard, which reuses+pulls an existing local checkout
  // (or clones once when none exists), registers it as a project, and
  // attaches it as a context folder. After a completed run the staged
  // attachment is marked installed (metadata-only, no clone).
  const folderOrigin: GitOrigin | null =
    typeId.type === 'folder'
      ? ((attachment?.git_origin ??
          (data as unknown as { origin?: Record<string, unknown> } | null)?.origin ??
          null) as GitOrigin | null)
      : null;
  const handleFolderPull = folderOrigin
    ? async () => {
        const url = gitOriginCloneUrl(folderOrigin);
        if (!url) return;
        const targetProjectId = projectId ?? dataContext.project?.id ?? null;
        const result = await launchWizard('git-context-folder', {
          title: `Pull ${attachment?.name ?? 'git folder'}`,
          targetTypeId: typeId.toString(),
          payload: { projectId: targetProjectId, scope: 'private', mode: 'existing', url },
        });
        if (result.status === 'done' && attachment && !attachment.installed) {
          try {
            await attachment.install(targetProjectId ? 'project' : 'user', targetProjectId ?? undefined);
          } catch {
            // Install here only flips the chip state — the checkout succeeded
            // in the wizard, so a bookkeeping failure stays quiet.
          }
        }
      }
    : null;
  // Assigned-task chip: one click unpacks — installs the staged task folder
  // (task.md) so it lands in the task list. Git context folders referenced by
  // the task ride as their own folder chips (the wizard-clone path above);
  // loose attachment files ride as ordinary file attachments on the message.
  const handleTaskInstall =
    typeId.type === Task.type && attachment && !attachment.installed
      ? async () => {
          const targetProjectId = projectId ?? dataContext.project?.id ?? null;
          await attachment.install(targetProjectId ? 'project' : 'user', targetProjectId ?? undefined);
        }
      : null;
  // "Run icon near the skill": one-click install-if-needed + run in a Vibe
  // session (see useRunReceivedSkill). Only for skills with a staged/installed
  // attachment — not artifacts or plain shares.
  const runnable = !!attachment && TESTABLE_TYPES.has(typeId.type);
  const runButton = runnable ? (
    <button
      type="button"
      title="Run skill"
      data-testid="skill-run-icon"
      onClick={() => startSkillRun(attachment, projectId ?? null)}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/50 bg-background text-primary transition-colors hover:bg-primary/10"
    >
      <Play className="h-3 w-3" />
    </button>
  ) : null;
  // The dialog is hoisted ABOVE the staged/installed branch: installing from
  // the open modal flips the chip staged → installed, and the modal must stay
  // mounted mid-session so its header can flip to Uninstall (not vanish).
  const dialog = attachment && reviewOpen && (
    <AssetReviewDialog
      open={reviewOpen}
      onClose={() => setReviewOpen(false)}
      attachment={attachment}
      targetTypeId={typeId}
      attachmentProjectId={projectId ?? null}
    />
  );
  if (state === 'staged') {
    return (
      <>
        <span className="inline-flex items-center gap-1">
          <EntityChip
            entity={{ typeId, type: typeId.type, id: typeId.id, name: attachment!.name ?? typeId.type }}
            staged
            onClick={
              handleFolderPull
                ? () => void handleFolderPull()
                : handleTaskInstall
                  ? () => void handleTaskInstall()
                  : () => setReviewOpen(true)
            }
          />
          {runButton}
        </span>
        {dialog}
        {runPicker}
      </>
    );
  }
  const artifact =
    typeId.type === Artifact.type && data
      ? data instanceof Artifact
        ? data
        : new Artifact(data as unknown as Partial<Artifact>)
      : null;
  // Installed via a MessageAttachment: the chip KEEPS opening the review modal
  // (uninstall / test live there — requirement: "if already installed,
  // uninstall appears instead"). The asset itself opens via the modal-adjacent
  // context panel or any normal entity surface. Chips without an attachment
  // (plain shares, artifacts) keep their navigation behavior — as do
  // receive_policy='auto' row-only types (shared transcripts, diagnoses):
  // they auto-installed at unpack with nothing to review, so their chip
  // navigates straight to the entity.
  const autoInstalled = dataManager.getTypeInfo?.(typeId.type)?.receive_policy === 'auto';
  return (
    <>
      <span className="inline-flex items-center gap-1">
        <ContextEntityChip
          typeId={typeId}
          inside={{ type: 'conversation', id: conversationId }}
          onClick={
            artifact
              ? () => void openArtifact(artifact, { navigation, currentProjectId: projectId ?? null })
              : handleFolderPull
                ? () => void handleFolderPull()
                : attachment && !autoInstalled
                  ? () => setReviewOpen(true)
                  : undefined
          }
          projectId={projectId}
        />
        {runButton}
      </span>
      {dialog}
      {runPicker}
    </>
  );
}
