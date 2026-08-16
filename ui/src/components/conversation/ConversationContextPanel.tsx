import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AgenticProcess,
  ClaudeSession,
  Conversation,
  dataManager,
  FlowMessage,
  ProcessStatus,
  QueryRequest,
  Skill,
  Spec,
  Task,
  TaskKind,
  TypeId,
} from '@sdk';
import { useEntitiesQuery, useEntity, useProject } from '@sdk/react/hooks';
import { useSessionDisplayName } from '@src/hooks/use-session-display-name';
import { attachmentDataString, type Attachment } from '@sdk/entities/flow-message';
import {
  Download,
  ExternalLink,
  FolderOpen,
  Pencil,
  Eye,
  Lock,
  Paperclip,
  Plus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { notify } from '@src/notifications';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { WorkerToolbar } from '@src/components/workers/WorkerToolbar';
import { localAttachmentUrl, dockPointerForLocalFile } from './attachment-url';
import { ICON_BY_TYPE, buildDockPointer } from './EntityChip';
import { buildAssistancePrompt } from './prompt-building';
import type { WorkerType } from './conversation-session-constants';
import { useConversationSession } from './useConversationSession';
import {
  buildAttachmentEntries,
  buildPrivateTypeIds,
  buildSharedEntities,
  buildSkipKeys,
  flowMessageIdSet as buildFlowMessageIdSet,
  orderMessagesByConversation,
  resolveAnchorMessage,
  resolveAttachmentProjectId,
  resolveProjectTypeId,
  type AttachmentEntry,
  type PrivateProcessAgg,
  type PrivateTaskAgg,
  type SharedEntityAgg,
} from './conversation-context-aggregation';

interface ConversationContextPanelProps {
  task: Task | null;
  conversation: Conversation | null;
  conversationId: string;
  /** Wraps any action that needs a `cwd`/project (still passed in case future
   *  Private Context entry types need it; currently unused here). */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** Currently-selected message ids. Drives bubble highlight and (only when
   *  `selectedEntityKey` is null) the origin-overlap highlight on entity
   *  rows. */
  selectedMessageIds?: readonly string[];
  /** Set when the user clicked an entity row (the click that *originated* the
   *  current selection). When non-null, only the matching row lights — every
   *  other entity in the selected messages stays dim, so the highlight tracks
   *  the user's actual pick instead of cascading through shared bubbles.
   *  `null` means the selection came from a bubble click, in which case the
   *  entity rows fall back to the "origin overlaps selectedMessageIds" rule. */
  selectedEntityKey?: string | null;
  /** Click on an entity's icon / type / name fires this with the row's stable
   *  key (TypeId string for entities, `${messageId}:${attachment.data}` for
   *  transcript / file rows) and the entity's *entire* origin list, so the
   *  parent can both pin the row and light every bubble that contributed it. */
  onSelectEntity?: (entityKey: string, messageIds: string[]) => void;
}

/** Title-case the type slug for human-friendly type labels in tables. */
function humanType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

/** Parent/child role of a task, used to refine the context-row type label.
 *  Only tasks IN a parent/child relationship get a special label:
 *   - 'group'  = the overview/parent task (``kind === 'group'``) → "Group Task"
 *   - 'member' = a child task (non-empty ``parent_id``)          → "Member Task"
 *  A standalone task returns null → plain "Task". */
function taskRole(
  task: { kind?: string | null; parent_id?: string | null } | null | undefined,
): 'group' | 'member' | null {
  if (!task) return null;
  if (task.kind === TaskKind.GROUP) return 'group';
  if (task.parent_id) return 'member';
  return null;
}

/** Canonical dock pointer for an entity TypeId — delegates to the single
 *  EntityChip dispatch (``buildDockPointer``). Asset types navigate by TypeId
 *  (the loader resolves the entity). */
function dockPointerFor(
  typeId: TypeId,
  inside?: { type: string; id: string },
  projectId?: string | null,
): DockPointer | null {
  const ptr = buildDockPointer({ type: typeId.type, id: typeId.id }, inside);
  return ptr ? DockPointer.rebaseAssetsOntoProject(ptr, projectId) : null;
}

/**
 * Body of the conversation drawer's "Context" tab. Two tables:
 *
 *   1. **Shared Context** — wire-bound entities each message and the
 *      conversation publish (``sharedContextEntities``), plus TYPE_ID
 *      attachments and the transcript attachment. Read-only links to open
 *      each in its viewer.
 *
 *   2. **Private Context** — spawn-children of this thread surfaced from the
 *      per-message ``sharedContextEntities`` walk: Tasks Claude derived
 *      headlessly, CC sessions started from a transcript. Backend spawn
 *      actions stamp the new entity into the source FlowMessage's
 *      ``shared_context_entities`` so the panel renders without a
 *      candidate-pull query. A "+" button publishes additional entities
 *      (Spec / Skill) into the conversation's shared bucket via the
 *      ``share-context`` backend action.
 */
export function ConversationContextPanel({
  task,
  conversation,
  conversationId,
  ensureMapped,
  selectedMessageIds,
  selectedEntityKey,
  onSelectEntity,
}: ConversationContextPanelProps) {
  // Normalise the optional selection input. A Set keeps the per-row overlap
  // check O(1) instead of O(n) on a list that may contain every message id
  // the user just clicked through.
  const selectedSet = useMemo(() => new Set(selectedMessageIds ?? []), [selectedMessageIds]);
  // When set, an entity row should light *only* when its key matches —
  // origin-overlap cascade is suppressed so clicking one entity doesn't
  // co-light every other entity that happens to share its messages.
  const entityKey = selectedEntityKey ?? null;
  // Fetch every FlowMessage in the conversation so we can aggregate context
  // across all of them. Sorting is deferred to the order the conversation
  // itself records on `conversationMessageIds` (the ordered jsonl pointer
  // list) — origin lists derived from this query are then re-sorted to that
  // order so click-back consistently jumps to the *earliest* occurrence.
  const flowMessagesQuery = useMemo(
    () =>
      new QueryRequest({
        type: FlowMessage.type,
        scope: [],
        name: `conv-flow-messages:${conversationId}`,
        query: undefined,
      }),
    [conversationId],
  );
  const { data: candidateFlowMessages = [], refetch: refetchFlowMessages } = useEntitiesQuery<FlowMessage>(
    flowMessagesQuery,
    {
      enabled: !!conversationId,
    },
  );

  // Type-level FlowMessage queries don't auto-invalidate when a new entity is
  // registered in the cache (see DataManager._query — it updates results but
  // doesn't call notifyCallbacks). So after a send, ConversationView refetches
  // the Conversation entity (pointer list grows) but the panel's flow-messages
  // query stays stale — the new message and its attachments never reach
  // buildAttachmentEntries / buildSharedEntities. Refetching when the pointer
  // count grows pulls the new FlowMessage and surfaces its attachments here.
  const pointerCount = conversation?.conversationMessageIds?.length ?? 0;
  const prevPointerCountRef = useRef(pointerCount);
  useEffect(() => {
    if (pointerCount > prevPointerCountRef.current) {
      void refetchFlowMessages();
    }
    prevPointerCountRef.current = pointerCount;
  }, [pointerCount, refetchFlowMessages]);

  // The conversation's pointer list is the authoritative ordering — same
  // approach `ConversationView` uses. We don't filter server-side on
  // `conversation_id` (it isn't reliably set on every FlowMessage), so this
  // pulls all FlowMessages and keeps only those whose id is in the pointer
  // list. Drops drafts / strays at the same time.
  const orderedMessages = useMemo(
    () => orderMessagesByConversation(conversation, candidateFlowMessages),
    [candidateFlowMessages, conversation],
  );

  const flowMessageIdSet = useMemo(() => buildFlowMessageIdSet(orderedMessages), [orderedMessages]);

  // ── Shared Context (aggregated) ──────────────────────────────────────
  const skipKeys = useMemo(() => buildSkipKeys(flowMessageIdSet, conversationId), [flowMessageIdSet, conversationId]);

  const sharedEntities = useMemo(
    () => buildSharedEntities(orderedMessages, skipKeys, conversation),
    [orderedMessages, skipKeys, conversation],
  );

  const attachmentEntries = useMemo(() => buildAttachmentEntries(orderedMessages), [orderedMessages]);

  // ── Private Context (aggregated across the whole conversation) ───────
  // Walk every ordered FlowMessage's *shared* bucket, pick out the TypeIds
  // that point at Tasks / AgenticProcesses (server-side spawn actions stamp
  // them there), resolve via the entity cache. No candidate-pull / no
  // unbounded query — see the Phase 3 plan write-up.
  const { privateTasks, privateProcesses } = useMemo(() => {
    const taskByKey = new Map<string, { task: Task; origins: string[] }>();
    const procByKey = new Map<string, { proc: AgenticProcess; origins: string[] }>();
    // Aggregate over every message's context bucket PLUS the conversation's own
    // (workers launched from the panel are linked onto the conversation, not a
    // message — see startSession). `origin` is the source id used for the
    // bubble-highlight; conversation-sourced entries have none (empty origins).
    const sources: { id: string | null; tids: readonly TypeId[] }[] = orderedMessages
      .filter((fm) => fm.id)
      .map((fm) => ({ id: fm.id, tids: fm.sharedContextEntities ?? [] }));
    if (conversation) {
      sources.push({ id: null, tids: conversation.sharedContextEntities ?? [] });
    }
    for (const { id: originId, tids } of sources) {
      for (const tid of tids) {
        const key = tid.toString();
        if (tid.type === Task.type) {
          const cached = dataManager.getByTypeIdFromCache<Task>(tid);
          if (!cached) continue;
          let entry = taskByKey.get(key);
          if (!entry) {
            entry = { task: cached, origins: [] };
            taskByKey.set(key, entry);
          }
          if (originId && !entry.origins.includes(originId)) entry.origins.push(originId);
        } else if (tid.type === AgenticProcess.type) {
          const cached = dataManager.getByTypeIdFromCache<AgenticProcess>(tid);
          if (!cached) continue;
          let entry = procByKey.get(key);
          if (!entry) {
            entry = { proc: cached, origins: [] };
            procByKey.set(key, entry);
          }
          if (originId && !entry.origins.includes(originId)) entry.origins.push(originId);
        }
      }
    }
    const tasksOut: PrivateTaskAgg[] = Array.from(taskByKey.values()).map(({ task: t, origins }) => ({
      task: t,
      originMessageIds: origins,
    }));
    const procsOut: PrivateProcessAgg[] = Array.from(procByKey.values()).map(({ proc, origins }) => ({
      process: proc,
      originMessageIds: origins,
    }));
    return { privateTasks: tasksOut, privateProcesses: procsOut };
  }, [orderedMessages, conversation]);

  const projectTypeId = useMemo(() => resolveProjectTypeId(task, conversation), [task, conversation]);
  const { project: currentProject } = useProject();
  const effectiveProjectId = resolveAttachmentProjectId(task, conversation, currentProject?.id);

  const privateTypeIds = useMemo(
    () => buildPrivateTypeIds(projectTypeId, privateTasks, privateProcesses),
    [projectTypeId, privateTasks, privateProcesses],
  );

  const sharedTypeIds = useMemo<TypeId[]>(() => sharedEntities.map((e) => e.typeId), [sharedEntities]);

  const anchorMessageId = useMemo(
    () => resolveAnchorMessage(selectedMessageIds, flowMessageIdSet, orderedMessages),
    [selectedMessageIds, flowMessageIdSet, orderedMessages],
  );

  // The conversation's owning worker session — one source of truth shared with
  // the conversation header (useConversationSession). Its presence is the gate:
  // present ⇒ the process is openable (rendered as a row below + Open in the
  // header); absent ⇒ offer the launch toolbar. The drawer supplies the full
  // context-aware launch prompt; the launch stamps ProcessKind.Conversation.
  const buildPrompt = useCallback(
    () => buildAssistancePrompt(sharedTypeIds, privateTypeIds),
    [sharedTypeIds, privateTypeIds],
  );
  const {
    conversationProcess,
    starting,
    launch: launchSession,
  } = useConversationSession({
    conversation,
    ensureMapped,
    buildPrompt,
  });
  const showStartSession = !conversationProcess;

  // Pull the bundle for the message that contributed an entity attachment. One
  // bundle materializes every attachment, so the originating bubble AND every
  // context row for those entities flip to "downloaded" together on the UPDATE.
  // Gated on project selection (assets land in the conversation's `.claude`).
  const handleDownloadEntity = useCallback(
    (messageId: string) => {
      const fm = orderedMessages.find((m) => m.id === messageId);
      if (!fm) return;
      const run = () => void fm.downloadAttachments();
      if (ensureMapped) ensureMapped(run);
      else void run();
    },
    [orderedMessages, ensureMapped],
  );

  if (orderedMessages.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        <Trans>No messages yet — context will appear here as they arrive.</Trans>
      </div>
    );
  }

  return (
    <div className="h-full space-y-4 overflow-y-auto p-3" data-testid="conversation-context-panel">
      <SharedContextSection
        sharedEntities={sharedEntities}
        attachmentEntries={attachmentEntries}
        conversationId={conversationId}
        selectedSet={selectedSet}
        selectedEntityKey={entityKey}
        onSelectEntity={onSelectEntity}
        onDownloadEntity={handleDownloadEntity}
        projectId={effectiveProjectId}
      />

      <PrivateContextSection
        anchorMessageId={anchorMessageId}
        conversationId={conversationId}
        conversation={conversation}
        projectTypeId={projectTypeId}
        tasks={privateTasks}
        processes={privateProcesses}
        selectedSet={selectedSet}
        selectedEntityKey={entityKey}
        onSelectEntity={onSelectEntity}
        onStartAssistance={showStartSession ? launchSession : undefined}
        starting={starting}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Shared Context
// ─────────────────────────────────────────────────────────────────────────

interface SharedContextSectionProps {
  sharedEntities: SharedEntityAgg[];
  attachmentEntries: AttachmentEntry[];
  conversationId: string;
  selectedSet: ReadonlySet<string>;
  selectedEntityKey: string | null;
  onSelectEntity?: (entityKey: string, messageIds: string[]) => void;
  /** Pull the bundle for the message that contributed an entity (gated on
   *  project selection). Drives the "Download <type>" row action. */
  onDownloadEntity?: (messageId: string) => void;
  projectId?: string | null;
}

function SharedContextSection({
  sharedEntities,
  attachmentEntries,
  conversationId,
  selectedSet,
  selectedEntityKey,
  onSelectEntity,
  onDownloadEntity,
  projectId,
}: SharedContextSectionProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const containerInside = useMemo(() => ({ type: Conversation.type, id: conversationId }), [conversationId]);

  const isEmpty = sharedEntities.length === 0 && attachmentEntries.length === 0;

  // When an entity is the selection origin, only the matching row lights;
  // otherwise we fall back to "any origin in selectedSet" so message-driven
  // selections still cascade their entities. This is the asymmetric rule:
  // entity → messages (one row), message → entities (all overlapping).
  const isRowHighlighted = (key: string, originMessageIds: readonly string[]): boolean => {
    if (selectedEntityKey !== null) return selectedEntityKey === key;
    return originMessageIds.some((id) => selectedSet.has(id));
  };

  return (
    <div>
      <SectionHeader title={t`Shared Context`} icon={Users} />
      {isEmpty ? (
        <EmptyHint text={t`Nothing shared in this conversation.`} />
      ) : (
        <ContextTable>
          {sharedEntities.map((entry) => {
            const rowKey = entry.typeId.toString();
            return (
              <SharedEntityRow
                key={rowKey}
                typeId={entry.typeId}
                originMessageIds={entry.originMessageIds}
                isHighlighted={isRowHighlighted(rowKey, entry.originMessageIds)}
                needsDownload={!!entry.downloadable && !entry.downloaded}
                onDownload={
                  onDownloadEntity && entry.downloadOriginMessageId
                    ? () => onDownloadEntity(entry.downloadOriginMessageId!)
                    : undefined
                }
                onSelect={
                  onSelectEntity && entry.originMessageIds.length > 0
                    ? () => onSelectEntity(rowKey, entry.originMessageIds)
                    : undefined
                }
                onOpen={() => {
                  const ptr = dockPointerFor(entry.typeId, containerInside, projectId);
                  if (ptr) navigation.openDock(ptr);
                }}
              />
            );
          })}
          {attachmentEntries.map((a) => {
            const rowKey = `${a.kind}:${a.messageId}:${attachmentDataString(a.attachment)}`;
            return (
              <AttachmentRow
                key={rowKey}
                messageId={a.messageId}
                attachment={a.attachment}
                kind={a.kind}
                originMessageIds={a.originMessageIds}
                isHighlighted={isRowHighlighted(rowKey, a.originMessageIds)}
                onSelect={
                  onSelectEntity && a.originMessageIds.length > 0
                    ? () => onSelectEntity(rowKey, a.originMessageIds)
                    : undefined
                }
              />
            );
          })}
        </ContextTable>
      )}
    </div>
  );
}

interface SharedEntityRowProps {
  typeId: TypeId;
  originMessageIds: string[];
  isHighlighted: boolean;
  /** Pre-bound to the parent's `onSelectEntity(rowKey, originMessageIds)` —
   *  rows don't need to know the key or the original origin list. */
  onSelect?: () => void;
  /** Fired with the resolved asset_ref (when the entity is an asset) so the
   *  parent can route skill/agent/markdown rows to the Assets editor. */
  onOpen: (assetRef?: string) => void;
  /** True when this entity rides in a message bundle that hasn't been pulled
   *  yet — the row shows "Download <type>" instead of "Open". Mirrors the
   *  transcript bubble's state (both read the message's `body_downloaded`). */
  needsDownload?: boolean;
  /** Pull the originating message's bundle (gated on project selection). */
  onDownload?: () => void;
}

function SharedEntityRow({
  typeId,
  originMessageIds,
  isHighlighted,
  onSelect,
  onOpen,
  needsDownload,
  onDownload,
}: SharedEntityRowProps) {
  const { t } = useLingui();
  const { data: entity } = useEntity(typeId);
  // A just-started claude_session has no title in its transcript yet, so the
  // indexer falls back to the bare session id and this row renders a UUID.
  // Heal it to the owning process's label; no-op for every other type.
  const name = useSessionDisplayName(
    typeId.type === ClaudeSession.type ? typeId.id : null,
    entity?.displayName ?? typeId.id,
  );
  const assetRef = (entity as unknown as { asset_ref?: string | null })?.asset_ref ?? undefined;
  const Icon = ICON_BY_TYPE[typeId.type] ?? ExternalLink;
  // Tasks in a parent/child relationship get a refined type label
  // ("Group Task" / "Member Task"); everything else uses the plain type word.
  const role =
    typeId.type === Task.type
      ? taskRole(entity as unknown as { kind?: string | null; parent_id?: string | null } | null)
      : null;
  const typeLabel = role === 'group' ? t`Group Task` : role === 'member' ? t`Member Task` : humanType(typeId.type);
  // Spec rows say "View" (they open in the Milkdown editor — see
  // DockPointer.forSpec → /dock/spec/<id>); everything else stays "Open".
  const isSpec = typeId.type === Spec.type;
  const primaryLabel = isSpec ? t`View` : t`Open`;
  const primaryIcon = isSpec ? <Eye className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />;
  return (
    <Row
      icon={Icon}
      type={typeLabel}
      name={name}
      isHighlighted={isHighlighted}
      onFocus={onSelect}
      focusTitle={
        originMessageIds.length > 1
          ? `Light up the ${originMessageIds.length} messages this is attached to`
          : 'Reveal the message that introduced this'
      }
    >
      {needsDownload && onDownload ? (
        <RowAction onClick={onDownload} title={`Download ${humanType(typeId.type)} — not pulled to this device yet`}>
          <Download className="h-3 w-3" />
          Download {humanType(typeId.type)}
        </RowAction>
      ) : (
        <RowAction onClick={() => onOpen(assetRef)} title={`${primaryLabel} ${humanType(typeId.type)}: ${name}`}>
          {primaryIcon}
          {primaryLabel}
        </RowAction>
      )}
    </Row>
  );
}

interface AttachmentRowProps {
  messageId: string;
  attachment: Attachment;
  kind: 'file' | 'prompt-file';
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelect?: () => void;
}

// Exported for the conversation-shared-md routing test (mirrors
// DownloadAttachmentsButton's test-export): the "Open" action must route a
// shared .md attachment to the markdown document editor, not the code editor.
export function AttachmentRow({ messageId, attachment, kind, isHighlighted, onSelect }: AttachmentRowProps) {
  const { t } = useLingui();
  // Same URL helper FlowMessageBubble uses to render its inline chips
  // (FlowMessageBubble.tsx:131) — points at the backend endpoint that streams
  // bytes from the FlowMessage's embedded VFS.
  // Defensive: stale/malformed rows can have a non-string `data`; the bare
  // `.split` used to crash the whole context panel for the entire conv.
  const { navigation } = useDockNavigation();
  const dataStr = attachmentDataString(attachment);
  // Null until the bytes are local — keeps the Download action from 404ing on a
  // body that was never pulled (see localAttachmentUrl).
  const downloadUrl = localAttachmentUrl(messageId, attachment);
  // Absolute path once the bytes are local — the editor opens this (standard
  // file dock pointer), mirroring the message bubble's file chip.
  const localPath = attachment.local_path ?? null;
  const filename = dataStr.split('/').pop() || dataStr || '(unknown)';
  const typeLabel = kind === 'prompt-file' ? t`Prompt file` : t`File`;

  return (
    <Row
      icon={Paperclip}
      type={typeLabel}
      name={filename}
      isHighlighted={isHighlighted}
      onFocus={onSelect}
      focusTitle={t`Reveal the message this file is attached to`}
    >
      {localPath && (
        <>
          <RowAction
            onClick={() => navigation.openDock(dockPointerForLocalFile(localPath))}
            title={`Open ${filename} in the editor`}
          >
            <ExternalLink className="h-3 w-3" />
            <Trans>Open</Trans>
          </RowAction>
          <RowAction
            onClick={() => void openExternalFromComputeNode('@local', localPath, { select: true })}
            title={`Reveal ${filename} in the file manager`}
          >
            <FolderOpen className="h-3 w-3" />
            <Trans>Reveal</Trans>
          </RowAction>
        </>
      )}
      {downloadUrl && (
        <RowAction
          onClick={() => window.open(downloadUrl, '_blank', 'noopener,noreferrer')}
          title={`Download ${filename}`}
        >
          <Download className="h-3 w-3" />
          <Trans>Download</Trans>
        </RowAction>
      )}
    </Row>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Private Context
// ─────────────────────────────────────────────────────────────────────────

interface PrivateContextSectionProps {
  /** FlowMessage id used as the anchor for the add-spec / add-skill links and
   *  the start-session lifecycle. Falls back to the most-recent message when no
   *  message is explicitly selected. `null` when the conversation is empty. */
  anchorMessageId: string | null;
  conversationId: string;
  /** Conversation entity for the current view. Used by add-spec to link the
   *  new spec into the conversation's `context_entities` so it shows up in
   *  Shared Context on later visits. `null` if not yet loaded. */
  conversation: Conversation | null;
  /** Mapped project (task.project_id / conversation.project_id) — rendered as
   *  a row at the top of Private Context. `null` when no project is mapped. */
  projectTypeId: TypeId | null;
  tasks: PrivateTaskAgg[];
  processes: PrivateProcessAgg[];
  selectedSet: ReadonlySet<string>;
  selectedEntityKey: string | null;
  onSelectEntity?: (entityKey: string, messageIds: string[]) => void;
  /** Wired to the worker-launch entries in the + menu — launches a session in
   *  the conversation's project with the chosen harness. Undefined when no task
   *  is mapped or a PTY session already exists in the conversation. */
  onStartAssistance?: (workerType: WorkerType) => void;
  starting: boolean;
}

function PrivateContextSection({
  anchorMessageId,
  conversationId,
  conversation,
  projectTypeId,
  tasks,
  processes,
  selectedSet,
  selectedEntityKey,
  onSelectEntity,
  onStartAssistance,
  starting,
}: PrivateContextSectionProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const containerInside = useMemo(() => ({ type: Conversation.type, id: conversationId }), [conversationId]);
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLaunchWorker = (workerType: WorkerType) => {
    if (!onStartAssistance) return;
    setMenuOpen(false);
    onStartAssistance(workerType);
  };

  // Create a fresh Spec linked back to this FlowMessage. The same pattern the
  // Session lifecycle uses — stamp `context_entities = [<FM TypeId>]` up-front
  // so a single save persists the linkage, and the new spec surfaces in the
  // Private Context table via the contextEntities filter without a second save.
  // Project scope (`scopeIds = [projectTypeId]`) keeps the spec under the
  // mapped project; falls back to user-home when unmapped.
  const handleAddSpec = async () => {
    if (!anchorMessageId || adding) return;
    const title = window.prompt('Spec title')?.trim();
    if (!title) return;
    setMenuOpen(false);
    setAdding(true);
    try {
      const fmTypeIdString = new TypeId(FlowMessage.type, anchorMessageId).toString();
      // The new Spec carries the anchor FM as its origin in its own *shared*
      // bucket — provenance that travels with the spec wherever it goes.
      const spec = new Spec({
        title,
        content: '',
        shared_context_entities: [fmTypeIdString],
      });
      const scopeIds = projectTypeId ? [projectTypeId] : [];
      await spec.save(scopeIds);
      // Publish the new spec onto the conversation's *shared* bucket via the
      // canonical share-context endpoint so the thread renders the chip
      // (Shared Context aggregation walks conversation.sharedContextEntities).
      if (conversation && spec.id) {
        try {
          await conversation.shareContextEntities(new TypeId(Spec.type, spec.id));
        } catch (convErr) {
          console.error('[PrivateContext] linking spec to conversation failed', convErr);
        }
      }
      notify.success({ title: t`Spec created` });
      if (spec.id) navigation.openDock(DockPointer.forSpec(spec.id));
    } catch (err) {
      console.error('[PrivateContext] add-spec failed', err);
      notify.error({ title: t`Failed to create spec` });
    } finally {
      setAdding(false);
    }
  };

  // Same shape as handleAddSpec, but for Skills. Backed by a SkillRecord on
  // disk; `asset_ref` is populated post-save and points at the skill folder
  // that the asset editor can edit (SKILL.md inside it).
  const handleAddSkill = async () => {
    if (!anchorMessageId || adding) return;
    const name = window.prompt('Skill name')?.trim();
    if (!name) return;
    setMenuOpen(false);
    setAdding(true);
    try {
      const fmTypeIdString = new TypeId(FlowMessage.type, anchorMessageId).toString();
      // Wire-bound shared_context_entities is on IEntity, not Skill itself —
      // cast widens the partial type so the wire field reaches deepAssign.
      const skill = new Skill({ name, shared_context_entities: [fmTypeIdString] } as Partial<Skill>);
      const scopeIds = projectTypeId ? [projectTypeId] : [];
      await skill.save(scopeIds);
      notify.success({ title: t`Skill created` });
      if (skill.asset_ref) {
        navigation.openDock(DockPointer.forAssetEditor('skill', skill.asset_ref));
      }
    } catch (err) {
      console.error('[PrivateContext] add-skill failed', err);
      notify.error({ title: t`Failed to create skill` });
    } finally {
      setAdding(false);
    }
  };

  // Split processes by role:
  //   - derivation workers (visible=false) — each backs a "deriving task…" row
  //     that becomes a fully-linked Task row once Claude saves the new Task.
  //   - transcript sessions (visible=true) — interactive PTYs the user opens
  //     directly via the existing PrivateProcessRow.
  const { derivationProcesses, transcriptProcesses } = useMemo(() => {
    const derivation: PrivateProcessAgg[] = [];
    const transcript: PrivateProcessAgg[] = [];
    for (const p of processes) {
      if (p.process.visible) transcript.push(p);
      else derivation.push(p);
    }
    return { derivationProcesses: derivation, transcriptProcesses: transcript };
  }, [processes]);

  // Pair each derivation process to the Task it produced (if any). The
  // server-side spawn action publishes the spawning AgenticProcess's TypeId
  // in the new Task's *shared* bucket (deterministic now — no longer
  // dependent on a Claude prompt instruction).
  const linkedTaskByProcessId = useMemo(() => {
    const map = new Map<string, PrivateTaskAgg>();
    for (const p of derivationProcesses) {
      if (!p.process.id) continue;
      const procKey = new TypeId(AgenticProcess.type, p.process.id).toString();
      const linked = tasks.find((t) => t.task.sharedContextEntities?.some((tid) => tid.toString() === procKey));
      if (linked) map.set(p.process.id, linked);
    }
    return map;
  }, [derivationProcesses, tasks]);

  // Tasks already represented by a paired derivation row are hidden from the
  // standalone list to avoid showing the same derivation twice.
  const standaloneTasks = useMemo(() => {
    const pairedTaskIds = new Set(
      Array.from(linkedTaskByProcessId.values())
        .map((t) => t.task.id)
        .filter((id): id is string => !!id),
    );
    return tasks.filter((t) => !t.task.id || !pairedTaskIds.has(t.task.id));
  }, [tasks, linkedTaskByProcessId]);

  const isEmpty =
    !projectTypeId &&
    standaloneTasks.length === 0 &&
    derivationProcesses.length === 0 &&
    transcriptProcesses.length === 0;

  // The + menu is the only entry point for adding to Private Context. It
  // surfaces Session (the assistance session lifecycle lifted to the panel),
  // Spec and Skill. Session is hidden when no task is mapped or a PTY session
  // already exists.
  const canAdd = !!onStartAssistance || (!!anchorMessageId && !adding);

  // Same selection-mode gate as SharedContextSection.
  const isRowHighlighted = (key: string, originMessageIds: readonly string[]): boolean => {
    if (selectedEntityKey !== null) return selectedEntityKey === key;
    return originMessageIds.some((id) => selectedSet.has(id));
  };

  return (
    <div>
      <SectionHeader title={t`Private Context`} icon={Lock} />
      {isEmpty ? (
        <EmptyHint text={t`Nothing here yet — use the + below to add one.`} />
      ) : (
        <ContextTable>
          {projectTypeId && (
            <ProjectRow
              typeId={projectTypeId}
              onOpen={() => {
                const ptr = dockPointerFor(projectTypeId, containerInside);
                if (ptr) navigation.openDock(ptr);
              }}
            />
          )}
          {standaloneTasks.map((t) => {
            const rowKey = t.task.typeId ? t.task.typeId.toString() : `task:${t.task.id ?? ''}`;
            return (
              <PrivateTaskRow
                key={t.task.id}
                task={t.task}
                originMessageIds={t.originMessageIds}
                isHighlighted={isRowHighlighted(rowKey, t.originMessageIds)}
                onSelect={
                  onSelectEntity && t.originMessageIds.length > 0
                    ? () => onSelectEntity(rowKey, t.originMessageIds)
                    : undefined
                }
                onView={() => {
                  if (!t.task.typeId) return;
                  const ptr = dockPointerFor(t.task.typeId, containerInside);
                  if (ptr) navigation.openDock(ptr);
                }}
                onEdit={() => {
                  if (!t.task.id) return;
                  navigation.openDock(DockPointer.forTasks(t.task.id, { conversationId }));
                }}
              />
            );
          })}
          {derivationProcesses.map((p) => {
            const linked = p.process.id ? linkedTaskByProcessId.get(p.process.id) : undefined;
            const rowKey = p.process.typeId ? p.process.typeId.toString() : `ap:${p.process.id ?? ''}`;
            return (
              <PrivateDerivationRow
                key={p.process.id}
                process={p.process}
                linkedTask={linked?.task}
                originMessageIds={p.originMessageIds}
                isHighlighted={isRowHighlighted(rowKey, p.originMessageIds)}
                onSelect={
                  onSelectEntity && p.originMessageIds.length > 0
                    ? () => onSelectEntity(rowKey, p.originMessageIds)
                    : undefined
                }
                onOpenTask={() => {
                  if (!linked?.task.id) return;
                  navigation.openDock(DockPointer.forTasks(linked.task.id, { conversationId }));
                }}
              />
            );
          })}
          {transcriptProcesses.map((p) => {
            const rowKey = p.process.typeId ? p.process.typeId.toString() : `ap:${p.process.id ?? ''}`;
            return (
              <PrivateProcessRow
                key={p.process.id}
                process={p.process}
                originMessageIds={p.originMessageIds}
                isHighlighted={isRowHighlighted(rowKey, p.originMessageIds)}
                onSelect={
                  onSelectEntity && p.originMessageIds.length > 0
                    ? () => onSelectEntity(rowKey, p.originMessageIds)
                    : undefined
                }
                onView={() => {
                  if (p.process.transcriptDockPointer) navigation.openDock(p.process.transcriptDockPointer);
                }}
                onOpen={() => {
                  if (p.process.terminalDockPointer) navigation.openDock(p.process.terminalDockPointer);
                }}
              />
            );
          })}
        </ContextTable>
      )}
      {canAdd && (
        <div className="relative mt-2">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={adding || starting}
            title={t`Add to Private Context`}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-background px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/5 hover:text-emerald-700 disabled:opacity-50 dark:hover:text-emerald-300"
            data-testid="private-context-add"
          >
            <Plus className="h-3.5 w-3.5" />
            <Trans>Add</Trans>
          </button>
          {menuOpen && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-border bg-popover p-1 text-xs shadow-md">
              {onStartAssistance && (
                <WorkerToolbar
                  variant="menu-list"
                  onLaunch={handleLaunchWorker}
                  starting={starting}
                  testIdPrefix="private-context"
                />
              )}
              <button
                type="button"
                onClick={() => void handleAddSpec()}
                disabled={adding}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                data-testid="private-context-add-spec"
              >
                {ICON_BY_TYPE.spec &&
                  (() => {
                    const Icon = ICON_BY_TYPE.spec;
                    return <Icon className="h-3 w-3 text-muted-foreground" />;
                  })()}
                <Trans>Spec</Trans>
              </button>
              <button
                type="button"
                onClick={() => void handleAddSkill()}
                disabled={adding}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                data-testid="private-context-add-skill"
              >
                {ICON_BY_TYPE.skill &&
                  (() => {
                    const Icon = ICON_BY_TYPE.skill;
                    return <Icon className="h-3 w-3 text-muted-foreground" />;
                  })()}
                <Trans>Skill</Trans>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Project row pinned at the top of Private Context — Open jumps to the
 *  project's primary dock, mirroring the EntityChip behaviour. */
function ProjectRow({ typeId, onOpen }: { typeId: TypeId; onOpen: () => void }) {
  const { t } = useLingui();
  const { data: entity } = useEntity(typeId);
  const name = entity?.displayName ?? typeId.id;
  const Icon = ICON_BY_TYPE.project ?? ExternalLink;
  return (
    <Row icon={Icon} type={t`Project`} name={name}>
      <RowAction onClick={onOpen} title={`Open Project: ${name}`}>
        <ExternalLink className="h-3 w-3" />
        <Trans>Open</Trans>
      </RowAction>
    </Row>
  );
}

function PrivateTaskRow({
  task,
  originMessageIds,
  isHighlighted,
  onSelect,
  onView,
  onEdit,
}: {
  task: Task;
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelect?: () => void;
  onView: () => void;
  onEdit: () => void;
}) {
  const { t } = useLingui();
  const Icon = ICON_BY_TYPE.task ?? ExternalLink;
  const role = taskRole(task);
  const typeLabel = role === 'group' ? t`Group Task` : role === 'member' ? t`Member Task` : t`Task`;
  return (
    <Row
      icon={Icon}
      type={typeLabel}
      name={task.displayName ?? task.id ?? '(unnamed)'}
      isHighlighted={isHighlighted}
      onFocus={onSelect}
      focusTitle={
        originMessageIds.length > 1
          ? `Light up the ${originMessageIds.length} messages this task is linked to`
          : t`Reveal the message this task was derived from`
      }
    >
      <RowAction onClick={onEdit} title={`Edit Task: ${task.displayName ?? ''}`}>
        <Pencil className="h-3 w-3" />
        <Trans>Edit</Trans>
      </RowAction>
      <RowAction onClick={onView} title={`View Task: ${task.displayName ?? ''}`}>
        <Eye className="h-3 w-3" />
        <Trans>View</Trans>
      </RowAction>
    </Row>
  );
}

function PrivateProcessRow({
  process,
  originMessageIds,
  isHighlighted,
  onSelect,
  onView,
  onOpen,
}: {
  process: AgenticProcess;
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelect?: () => void;
  /** Read-only transcript view (lens). Disabled when there's no
   *  `session_id` yet — nothing to read until the worker has produced one. */
  onView: () => void;
  /** Live PTY terminal. */
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const Icon = ICON_BY_TYPE.agentic_process ?? ExternalLink;
  const hasSession = !!process.session_id;
  return (
    <Row
      icon={Icon}
      type={t`Session`}
      name={process.displayName ?? process.id ?? '(running)'}
      isHighlighted={isHighlighted}
      onFocus={onSelect}
      focusTitle={
        originMessageIds.length > 1
          ? `Light up the ${originMessageIds.length} messages this session is linked to`
          : t`Reveal the message this session was started from`
      }
    >
      <RowAction
        onClick={onView}
        disabled={!hasSession}
        title={hasSession ? t`View the session transcript` : t`No transcript yet — the worker has not produced one`}
      >
        <Eye className="h-3 w-3" />
        <Trans>View</Trans>
      </RowAction>
      <RowAction onClick={onOpen} title={t`Open the live session in a terminal`}>
        <ExternalLink className="h-3 w-3" />
        <Trans>Open session</Trans>
      </RowAction>
    </Row>
  );
}

// Single row representing a "derive task" headless run. The Task is
// pre-created server-side (placeholder title from FM text), so `linkedTask`
// is defined from the moment the row appears. The Open button is gated on the
// AgenticProcess lifecycle: disabled while the Claude run is still ongoing
// (NEW/STARTING/RUNNING/STOPPING), enabled once it lands in STOPPED/FAILED.
// Click navigates to the (now refined) Task view.
function PrivateDerivationRow({
  process,
  linkedTask,
  originMessageIds,
  isHighlighted,
  onSelect,
  onOpenTask,
}: {
  process: AgenticProcess;
  linkedTask: Task | undefined;
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelect?: () => void;
  onOpenTask: () => void;
}) {
  const { t } = useLingui();
  const Icon = ICON_BY_TYPE.task ?? ExternalLink;
  const status = process.status;
  const ready = status === ProcessStatus.STOPPED || status === ProcessStatus.FAILED;
  const name =
    linkedTask?.displayName ??
    linkedTask?.id ??
    (process.displayName ? `Deriving task… (${process.displayName})` : t`Deriving task…`);
  return (
    <Row
      icon={Icon}
      type={t`Task`}
      name={name}
      isHighlighted={isHighlighted}
      onFocus={onSelect}
      focusTitle={
        originMessageIds.length > 1
          ? `Light up the ${originMessageIds.length} messages this task is linked to`
          : t`Reveal the message this task was derived from`
      }
    >
      <RowAction
        onClick={onOpenTask}
        disabled={!ready || !linkedTask}
        title={ready ? `Open Task: ${linkedTask?.displayName ?? ''}` : t`Deriving with Claude…`}
      >
        <ExternalLink className="h-3 w-3" />
        <Trans>Open</Trans>
      </RowAction>
    </Row>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Layout primitives
// ─────────────────────────────────────────────────────────────────────────

function SectionHeader({ title, icon: Icon }: { title: string; icon?: LucideIcon }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      {Icon && <Icon className="h-3 w-3 text-foreground" aria-hidden="true" />}
      <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">{title}</span>
    </div>
  );
}

function ContextTable({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border rounded border border-border bg-background">{children}</div>;
}

function Row({
  icon: Icon,
  type,
  name,
  isHighlighted,
  onFocus,
  focusTitle,
  children,
}: {
  icon: LucideIcon;
  type: string;
  name: string;
  /** Subtle ring on the row when its origin message is the selected one. */
  isHighlighted?: boolean;
  /** Click on the icon/type/name cluster fires this — used to pop the
   *  conversation back to the message that introduced this entity. The action
   *  buttons rendered as `children` keep their native behavior (navigation,
   *  edit, etc.) and don't trigger this. */
  onFocus?: () => void;
  /** Tooltip + aria-label for the focus button. */
  focusTitle?: string;
  children: React.ReactNode;
}) {
  const clickable = !!onFocus;
  const focusInner = (
    <>
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{type}</span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={name}>
        {name}
      </span>
    </>
  );
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 text-[11px] transition-colors ${
        isHighlighted ? 'bg-muted/30 ring-1 ring-inset ring-ring/40' : ''
      }`}
    >
      {clickable ? (
        <button
          type="button"
          onClick={onFocus}
          title={focusTitle}
          aria-label={focusTitle ?? `Reveal ${type}: ${name}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-start transition-colors hover:bg-muted/40"
        >
          {focusInner}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{focusInner}</div>
      )}
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

interface RowActionBaseProps {
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
}
type RowActionProps = RowActionBaseProps &
  (
    | { as?: 'button'; onClick: () => void; href?: never; target?: never; rel?: never }
    | { as: 'a'; href: string; target?: string; rel?: string; onClick?: () => void }
  );

function RowAction(props: RowActionProps) {
  const className =
    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50';
  if (props.as === 'a') {
    const { href, target, rel, title, children, onClick } = props;
    return (
      <a href={href} target={target} rel={rel} title={title} onClick={onClick} className={className}>
        {children}
      </a>
    );
  }
  const { onClick, title, disabled, children } = props;
  return (
    <button type="button" onClick={onClick} title={title} disabled={disabled} className={className}>
      {children}
    </button>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-border px-2 py-2 text-center text-[11px] italic text-muted-foreground/70">
      {text}
    </div>
  );
}
