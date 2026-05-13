import { useCallback, useMemo, useState } from 'react';
import {
  AgenticProcess,
  Conversation,
  dataManager,
  FlowMessage,
  ProcessStatus,
  QueryFilter,
  QueryRequest,
  Skill,
  Spec,
  Task,
  TypeId,
} from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';
import { useEntitiesQuery, useEntity } from '@sdk/react/hooks';
import type { Attachment } from '@sdk/entities/flow-message';
import {
  Download,
  ExternalLink,
  Pencil,
  Eye,
  Lock,
  Paperclip,
  PlayCircle,
  Plus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { fileAttachmentUrl } from './attachment-url';
import { ICON_BY_TYPE } from './EntityChip';
import { buildAssistancePrompt } from './prompt-building';
import {
  aggregatePrivateProcesses,
  aggregatePrivateTasks,
  buildAttachmentEntries,
  buildPrivateTypeIds,
  buildSharedEntities,
  buildSkipKeys,
  buildTranscriptEntries,
  flowMessageIdSet as buildFlowMessageIdSet,
  orderMessagesByConversation,
  resolveAnchorMessage,
  resolveProjectTypeId,
  type AttachmentEntry,
  type PrivateProcessAgg,
  type PrivateTaskAgg,
  type SharedEntityAgg,
  type TranscriptEntry,
} from './conversation-context-aggregation';

interface ConversationContextPanelProps {
  task: Task | null;
  conversation: Conversation | null;
  conversationId: string;
  /** Wraps any action that needs a `cwd`/project (still passed in case future
   *  Private Context entry types need it; currently unused here). */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** Currently-selected message ids. A row lights up when its origin set
   *  has any overlap with this list — so clicking a multi-message entity
   *  keeps the row lit no matter which of its origin bubbles is picked next,
   *  and clicking a bubble lights up every entity it contributed. */
  selectedMessageIds?: readonly string[];
  /** Click on an entity's icon / type / name fires this with the entity's
   *  *entire* origin list, so every message the entity is attached to lights
   *  up at once (parent scrolls to the first / earliest one). */
  onSelectMessages?: (messageIds: string[]) => void;
}

/** Title-case the type slug for human-friendly type labels in tables. */
function humanType(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

/** Build the canonical dock pointer for an entity TypeId, mirroring EntityChip. */
function dockPointerFor(typeId: TypeId, inside?: { type: string; id: string }): DockPointer | null {
  switch (typeId.type) {
    case 'project':
      return DockPointer.forProject(
        typeId.id,
        inside?.type === 'conversation' ? { conversationId: inside.id } : undefined,
      );
    case 'task':
      return DockPointer.forTasks(
        typeId.id,
        inside?.type === 'conversation' ? { conversationId: inside.id } : undefined,
      );
    case 'spec':
      return DockPointer.forSpec(typeId.id);
    case 'conversation':
      return DockPointer.forConversation(typeId.id);
    default:
      try {
        return DockPointer.fromUrl(typeId.type, typeId.id);
      } catch {
        return null;
      }
  }
}

/**
 * Body of the conversation drawer's "Context" tab. Two tables:
 *
 *   1. **Shared Context** — entities the message itself carries (project,
 *      message `contextEntities`, TYPE_ID attachments, transcript attachment).
 *      Read-only links to open each in its viewer.
 *
 *   2. **Private Context** — items the local user explicitly attached to this
 *      message: Tasks Claude derived headlessly, CC sessions started from a
 *      transcript. Linkage stored on the new entity (FlowMessage TypeId in
 *      `context_entities` for Tasks, `target_vfs_path` for AgenticProcess).
 *      A "+" button picks the entity type to add (Task only for now).
 */
export function ConversationContextPanel({
  task,
  conversation,
  conversationId,
  ensureMapped,
  selectedMessageIds,
  onSelectMessages,
}: ConversationContextPanelProps) {
  // Normalise the optional selection input. A Set keeps the per-row overlap
  // check O(1) instead of O(n) on a list that may contain every message id
  // the user just clicked through.
  const selectedSet = useMemo(
    () => new Set(selectedMessageIds ?? []),
    [selectedMessageIds],
  );
  // Fetch every FlowMessage in the conversation so we can aggregate context
  // across all of them. Sorting is deferred to the order the conversation
  // itself records on `conversationMessageIds` (the ordered jsonl pointer
  // list) — origin lists derived from this query are then re-sorted to that
  // order so click-back consistently jumps to the *earliest* occurrence.
  const flowMessagesQuery = useMemo(
    () => new QueryRequest({
      type: FlowMessage.type,
      scope: [],
      name: `conv-flow-messages:${conversationId}`,
      query: undefined,
    }),
    [conversationId],
  );
  const { data: candidateFlowMessages = [] } = useEntitiesQuery<FlowMessage>(flowMessagesQuery, {
    enabled: !!conversationId,
  });

  // The conversation's pointer list is the authoritative ordering — same
  // approach `ConversationView` uses. We don't filter server-side on
  // `conversation_id` (it isn't reliably set on every FlowMessage), so this
  // pulls all FlowMessages and keeps only those whose id is in the pointer
  // list. Drops drafts / strays at the same time.
  const orderedMessages = useMemo(
    () => orderMessagesByConversation(conversation, candidateFlowMessages),
    [candidateFlowMessages, conversation],
  );

  const flowMessageIdSet = useMemo(
    () => buildFlowMessageIdSet(orderedMessages),
    [orderedMessages],
  );

  // ── Shared Context (aggregated) ──────────────────────────────────────
  const skipKeys = useMemo(
    () => buildSkipKeys(flowMessageIdSet, conversationId, task),
    [flowMessageIdSet, conversationId, task],
  );

  const sharedEntities = useMemo(
    () => buildSharedEntities(orderedMessages, skipKeys),
    [orderedMessages, skipKeys],
  );

  const transcriptEntries = useMemo(
    () => buildTranscriptEntries(orderedMessages),
    [orderedMessages],
  );

  const attachmentEntries = useMemo(
    () => buildAttachmentEntries(orderedMessages),
    [orderedMessages],
  );

  // ── Private Context (aggregated across the whole conversation) ───────
  // Pull every Task / AgenticProcess scoped by project_id (project gives the
  // backend a useful index), then keep only those whose `contextEntities`
  // reference a FlowMessage in this thread. Same single-criterion shape
  // usePrivateContext uses — preserved for the same backend reasons.
  const projectIdLifted = task?.project_id ?? conversation?.project_id ?? null;
  const tasksQuery = useMemo(
    () => new QueryRequest({
      type: Task.type,
      scope: [],
      name: `conv-private-tasks:${conversationId}:${projectIdLifted ?? 'noproj'}`,
      query: projectIdLifted ? new QueryFilter({ match: { project_id: projectIdLifted } }) : undefined,
    }),
    [conversationId, projectIdLifted],
  );
  const { data: candidateTasks = [] } = useEntitiesQuery<Task>(tasksQuery, {
    enabled: flowMessageIdSet.size > 0,
  });

  const processQuery = useMemo(
    () => new QueryRequest({
      type: AgenticProcess.type,
      scope: [],
      name: `conv-private-processes:${conversationId}`,
      query: undefined,
    }),
    [conversationId],
  );
  const { data: candidateProcesses = [], isSuccess: processesLoaded } =
    useEntitiesQuery<AgenticProcess>(processQuery, {
      enabled: flowMessageIdSet.size > 0,
    });

  const privateTasks = useMemo(
    () => aggregatePrivateTasks(candidateTasks, flowMessageIdSet),
    [candidateTasks, flowMessageIdSet],
  );

  const privateProcesses = useMemo(
    () => aggregatePrivateProcesses(candidateProcesses, flowMessageIdSet),
    [candidateProcesses, flowMessageIdSet],
  );

  // PTY-backed (visible) sessions block "Start session" affordances — same
  // rule as the per-message version, just lifted to conversation scope.
  const hasTranscriptSession = privateProcesses.some((p) => p.process.visible);
  const showStartSession = processesLoaded && !hasTranscriptSession;

  const projectTypeId = useMemo(
    () => resolveProjectTypeId(task, conversation),
    [task, conversation],
  );

  const privateTypeIds = useMemo(
    () => buildPrivateTypeIds(projectTypeId, privateTasks, privateProcesses),
    [projectTypeId, privateTasks, privateProcesses],
  );

  const sharedTypeIds = useMemo<TypeId[]>(
    () => sharedEntities.map((e) => e.typeId),
    [sharedEntities],
  );

  const anchorMessageId = useMemo(
    () => resolveAnchorMessage(selectedMessageIds, flowMessageIdSet, orderedMessages),
    [selectedMessageIds, flowMessageIdSet, orderedMessages],
  );

  // ─── Lifted start-session lifecycle (basic primitives per
  //     docs/agent-management/agentic-process.md). Same flow for both the
  //     "Implement Plan" spec-row chip and the "Use Flowpad assistance"
  //     rectangular button — only the injected instruction differs.
  const [starting, setStarting] = useState(false);
  const startSession = useCallback(
    async (buildInstruction: () => Promise<string>) => {
      if (!anchorMessageId || !task || starting) return;
      const workdir = task.project_root ?? undefined;
      if (!workdir) {
        toast.warning('Map this conversation to a local project first.');
        return;
      }
      setStarting(true);
      try {
        const instruction = await buildInstruction();
        const fmTypeIdString = new TypeId(FlowMessage.type, anchorMessageId).toString();
        const cliConfig = new ClaudeCliOptions({ permission_mode: 'bypassPermissions' });
        const proc = await new AgenticProcess({
          cli_config: cliConfig.toJson(),
          context_data: { project_id: task.project_id ?? undefined },
          workdir,
          visible: true,
          context_entities: [fmTypeIdString],
        }).save();
        await proc.start({ instruction });
        proc.openTerminalDock();
      } catch (err) {
        console.error('[ContextPanel] start session failed', err);
        toast.error('Failed to start session');
      } finally {
        setStarting(false);
      }
    },
    [anchorMessageId, task, starting],
  );

  const handleStartAssistance = useCallback(() => {
    const run = () =>
      startSession(() => Promise.resolve(buildAssistancePrompt(sharedTypeIds, privateTypeIds)));
    if (ensureMapped) ensureMapped(run);
    else void run();
  }, [startSession, sharedTypeIds, privateTypeIds, ensureMapped]);

  if (orderedMessages.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        No messages yet — context will appear here as they arrive.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4" data-testid="conversation-context-panel">
      <SharedContextSection
        sharedEntities={sharedEntities}
        transcriptEntries={transcriptEntries}
        attachmentEntries={attachmentEntries}
        conversationId={conversationId}
        selectedSet={selectedSet}
        onSelectMessages={onSelectMessages}
      />

      <PrivateContextSection
        anchorMessageId={anchorMessageId}
        conversationId={conversationId}
        projectTypeId={projectTypeId}
        tasks={privateTasks}
        processes={privateProcesses}
        selectedSet={selectedSet}
        onSelectMessages={onSelectMessages}
        onStartAssistance={task && showStartSession ? handleStartAssistance : undefined}
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
  transcriptEntries: TranscriptEntry[];
  attachmentEntries: AttachmentEntry[];
  conversationId: string;
  selectedSet: ReadonlySet<string>;
  onSelectMessages?: (messageIds: string[]) => void;
}

function SharedContextSection({
  sharedEntities,
  transcriptEntries,
  attachmentEntries,
  conversationId,
  selectedSet,
  onSelectMessages,
}: SharedContextSectionProps) {
  const { navigation } = useDockNavigation();
  const containerInside = { type: Conversation.type, id: conversationId };

  const isEmpty =
    sharedEntities.length === 0
    && transcriptEntries.length === 0
    && attachmentEntries.length === 0;

  return (
    <div>
      <SectionHeader title="Shared Context" icon={Users} />
      {isEmpty ? (
        <EmptyHint text="Nothing shared in this conversation." />
      ) : (
        <ContextTable>
          {sharedEntities.map((entry) => (
            <SharedEntityRow
              key={entry.typeId.toString()}
              typeId={entry.typeId}
              originMessageIds={entry.originMessageIds}
              isHighlighted={entry.originMessageIds.some((id) => selectedSet.has(id))}
              onSelectMessages={onSelectMessages}
              onOpen={() => {
                const ptr = dockPointerFor(entry.typeId, containerInside);
                if (ptr) navigation.openDock(ptr);
              }}
            />
          ))}
          {transcriptEntries.map((t) => (
            <TranscriptRow
              key={`${t.messageId}:${t.attachment.data}`}
              messageId={t.messageId}
              attachment={t.attachment}
              originMessageIds={t.originMessageIds}
              isHighlighted={t.originMessageIds.some((id) => selectedSet.has(id))}
              onSelectMessages={onSelectMessages}
            />
          ))}
          {attachmentEntries.map((a) => (
            <AttachmentRow
              key={`${a.messageId}:${a.kind}:${a.attachment.data}`}
              messageId={a.messageId}
              attachment={a.attachment}
              kind={a.kind}
              originMessageIds={a.originMessageIds}
              isHighlighted={a.originMessageIds.some((id) => selectedSet.has(id))}
              onSelectMessages={onSelectMessages}
            />
          ))}
        </ContextTable>
      )}
    </div>
  );
}

interface SharedEntityRowProps {
  typeId: TypeId;
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelectMessages?: (messageIds: string[]) => void;
  onOpen: () => void;
}

function SharedEntityRow({
  typeId,
  originMessageIds,
  isHighlighted,
  onSelectMessages,
  onOpen,
}: SharedEntityRowProps) {
  const { data: entity } = useEntity(typeId);
  const name = entity?.displayName ?? typeId.id;
  const Icon = ICON_BY_TYPE[typeId.type] ?? ExternalLink;
  // Spec rows say "View" (they open in the Milkdown editor — see
  // DockPointer.forSpec → /dock/spec/<id>); everything else stays "Open".
  const isSpec = typeId.type === Spec.type;
  const primaryLabel = isSpec ? 'View' : 'Open';
  const primaryIcon = isSpec ? <Eye className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />;
  return (
    <Row
      icon={Icon}
      type={humanType(typeId.type)}
      name={name}
      isHighlighted={isHighlighted}
      onFocus={
        onSelectMessages && originMessageIds.length > 0
          ? () => onSelectMessages(originMessageIds)
          : undefined
      }
      focusTitle={
        originMessageIds.length > 1
          ? `Light up the ${originMessageIds.length} messages this is attached to`
          : 'Reveal the message that introduced this'
      }
    >
      <RowAction onClick={onOpen} title={`${primaryLabel} ${humanType(typeId.type)}: ${name}`}>
        {primaryIcon}
        {primaryLabel}
      </RowAction>
    </Row>
  );
}

interface TranscriptRowProps {
  messageId: string;
  attachment: Attachment;
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelectMessages?: (messageIds: string[]) => void;
}

function TranscriptRow({
  messageId,
  attachment,
  originMessageIds,
  isHighlighted,
  onSelectMessages,
}: TranscriptRowProps) {
  const { navigation } = useDockNavigation();
  // ``attachment.local_path`` is synthesized at serialization time by
  // ``flow_message.py::_serialize_with_local_paths`` from the local backend's
  // ``tempfile.gettempdir()``. On macOS that's ``/var/folders/.../T/…`` and on
  // Windows that's ``C:\Users\…\AppData\Local\Temp\…`` — both valid local paths
  // for the backend that produced them. The download URL is the fallback when
  // no local path is populated.
  const localPath = attachment.local_path ?? null;
  const downloadUrl = fileAttachmentUrl(messageId, attachment.data);

  const handleView = () => {
    if (localPath) {
      // ``claude/transcript`` handles the absolute-path form via LensViewer's
      // Form 2 branch (POSIX or Windows-style absolute paths are both
      // forwarded to ``TranscriptViewer path={…}``).
      navigation.openLens('claude', 'transcript', encodeURIComponent(localPath));
    } else {
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <Row
      icon={ICON_BY_TYPE.conversation ?? ExternalLink}
      type="Transcript"
      name={attachment.data.split('/').pop() ?? attachment.data}
      isHighlighted={isHighlighted}
      onFocus={
        onSelectMessages && originMessageIds.length > 0
          ? () => onSelectMessages(originMessageIds)
          : undefined
      }
      focusTitle="Reveal the message that produced this transcript"
    >
      <RowAction
        onClick={handleView}
        title={localPath ? 'Open in the transcript viewer' : 'Open the raw JSONL in a new tab'}
      >
        <Eye className="h-3 w-3" />
        View
      </RowAction>
    </Row>
  );
}

interface AttachmentRowProps {
  messageId: string;
  attachment: Attachment;
  kind: 'file' | 'prompt-file';
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelectMessages?: (messageIds: string[]) => void;
}

function AttachmentRow({
  messageId,
  attachment,
  kind,
  originMessageIds,
  isHighlighted,
  onSelectMessages,
}: AttachmentRowProps) {
  // Same URL helper FlowMessageBubble uses to render its inline chips
  // (FlowMessageBubble.tsx:131) — points at the backend endpoint that streams
  // bytes from the FlowMessage's embedded VFS.
  const downloadUrl = fileAttachmentUrl(messageId, attachment.data);
  const filename = attachment.data.split('/').pop() ?? attachment.data;
  const typeLabel = kind === 'prompt-file' ? 'Prompt file' : 'File';

  return (
    <Row
      icon={Paperclip}
      type={typeLabel}
      name={filename}
      isHighlighted={isHighlighted}
      onFocus={
        onSelectMessages && originMessageIds.length > 0
          ? () => onSelectMessages(originMessageIds)
          : undefined
      }
      focusTitle="Reveal the message this file is attached to"
    >
      <RowAction
        onClick={() => window.open(downloadUrl, '_blank', 'noopener,noreferrer')}
        title={`Download ${filename}`}
      >
        <Download className="h-3 w-3" />
        Download
      </RowAction>
    </Row>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Private Context
// ─────────────────────────────────────────────────────────────────────────

interface PrivateContextSectionProps {
  /** FlowMessage id used as the anchor for the `derive-task` action and the
   *  start-session lifecycle. Falls back to the most-recent message when no
   *  message is explicitly selected. `null` when the conversation is empty. */
  anchorMessageId: string | null;
  conversationId: string;
  /** Mapped project (task.project_id / conversation.project_id) — rendered as
   *  a row at the top of Private Context. `null` when no project is mapped. */
  projectTypeId: TypeId | null;
  tasks: PrivateTaskAgg[];
  processes: PrivateProcessAgg[];
  selectedSet: ReadonlySet<string>;
  onSelectMessages?: (messageIds: string[]) => void;
  /** Wired to the Session entry in the + menu. Undefined when no task is
   *  mapped or a PTY session already exists in the conversation. */
  onStartAssistance?: () => void;
  starting: boolean;
}

function PrivateContextSection({
  anchorMessageId,
  conversationId,
  projectTypeId,
  tasks,
  processes,
  selectedSet,
  onSelectMessages,
  onStartAssistance,
  starting,
}: PrivateContextSectionProps) {
  const { navigation } = useDockNavigation();
  const containerInside = { type: Conversation.type, id: conversationId };
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Derive a fresh Task headlessly from the anchor FlowMessage. Server side
  // spawns an AgenticProcess that creates the Task and links both back via
  // context_entities, so the new rows appear in Private Context automatically.
  const handleAddTask = async () => {
    if (!anchorMessageId || adding) return;
    setMenuOpen(false);
    setAdding(true);
    try {
      const action = new ActionInfo('derive-task', 'flow_message', anchorMessageId, 'POST');
      const res = await dataManager.callAction<unknown, { process_id?: string; task_id?: string }>(action);
      if (res?.task_id || res?.process_id) {
        toast.success('Deriving task with Claude…');
      } else {
        toast.error('Failed to start task derivation');
      }
    } catch (err) {
      console.error('[PrivateContext] derive-task failed', err);
      toast.error('Failed to derive task');
    } finally {
      setAdding(false);
    }
  };

  const handleStartSessionFromMenu = () => {
    if (!onStartAssistance) return;
    setMenuOpen(false);
    onStartAssistance();
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
      const spec = new Spec({
        title,
        content: '',
        context_entities: [fmTypeIdString],
      });
      const scopeIds = projectTypeId ? [projectTypeId] : [];
      await spec.save(scopeIds);
      toast.success('Spec created');
      if (spec.id) navigation.openDock(DockPointer.forSpec(spec.id));
    } catch (err) {
      console.error('[PrivateContext] add-spec failed', err);
      toast.error('Failed to create spec');
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
      const skill = new Skill({ name, context_entities: [fmTypeIdString] });
      const scopeIds = projectTypeId ? [projectTypeId] : [];
      await skill.save(scopeIds);
      toast.success('Skill created');
      if (skill.asset_ref) {
        navigation.openDock(DockPointer.forAssetEditor('skill', skill.asset_ref));
      }
    } catch (err) {
      console.error('[PrivateContext] add-skill failed', err);
      toast.error('Failed to create skill');
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

  // Pair each derivation process to the Task it produced (if any). Claude is
  // instructed to add the spawning AgenticProcess's TypeId to the new Task's
  // context_entities so we can match them here.
  const linkedTaskByProcessId = useMemo(() => {
    const map = new Map<string, PrivateTaskAgg>();
    for (const p of derivationProcesses) {
      if (!p.process.id) continue;
      const procKey = new TypeId(AgenticProcess.type, p.process.id).toString();
      const linked = tasks.find((t) =>
        t.task.contextEntities?.some((tid) => tid.toString() === procKey),
      );
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
  // surfaces Task (server-side `derive-task`) and Session (the assistance
  // session lifecycle lifted to the panel). Session is hidden when no task is
  // mapped or a PTY session already exists.
  const canAdd = !!onStartAssistance || (!!anchorMessageId && !adding);

  return (
    <div>
      <SectionHeader title="Private Context" icon={Lock} />
      {isEmpty ? (
        <EmptyHint text="Nothing here yet — use the + below to add one." />
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
          {standaloneTasks.map((t) => (
            <PrivateTaskRow
              key={t.task.id}
              task={t.task}
              originMessageIds={t.originMessageIds}
              isHighlighted={t.originMessageIds.some((id) => selectedSet.has(id))}
              onSelectMessages={onSelectMessages}
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
          ))}
          {derivationProcesses.map((p) => {
            const linked = p.process.id ? linkedTaskByProcessId.get(p.process.id) : undefined;
            return (
              <PrivateDerivationRow
                key={p.process.id}
                process={p.process}
                linkedTask={linked?.task}
                originMessageIds={p.originMessageIds}
                isHighlighted={p.originMessageIds.some((id) => selectedSet.has(id))}
                onSelectMessages={onSelectMessages}
                onOpenTask={() => {
                  if (!linked?.task.id) return;
                  navigation.openDock(
                    DockPointer.forTasks(linked.task.id, { conversationId }),
                  );
                }}
              />
            );
          })}
          {transcriptProcesses.map((p) => (
            <PrivateProcessRow
              key={p.process.id}
              process={p.process}
              originMessageIds={p.originMessageIds}
              isHighlighted={p.originMessageIds.some((id) => selectedSet.has(id))}
              onSelectMessages={onSelectMessages}
              onView={() => {
                if (p.process.transcriptDockPointer) navigation.openDock(p.process.transcriptDockPointer);
              }}
              onOpen={() => {
                if (p.process.terminalDockPointer) navigation.openDock(p.process.terminalDockPointer);
              }}
            />
          ))}
        </ContextTable>
      )}
      {canAdd && (
        <div className="relative mt-2">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={adding || starting}
            title="Add to Private Context"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-background px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/5 hover:text-emerald-700 disabled:opacity-50 dark:hover:text-emerald-300"
            data-testid="private-context-add"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
          {menuOpen && (
            <div className="absolute top-full left-0 right-0 z-10 mt-1 rounded-md border border-border bg-popover p-1 text-xs shadow-md">
              <button
                type="button"
                onClick={() => void handleAddTask()}
                disabled={adding}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                data-testid="private-context-add-task"
              >
                {ICON_BY_TYPE.task &&
                  (() => {
                    const Icon = ICON_BY_TYPE.task;
                    return <Icon className="h-3 w-3 text-muted-foreground" />;
                  })()}
                Task
              </button>
              {onStartAssistance && (
                <button
                  type="button"
                  onClick={handleStartSessionFromMenu}
                  disabled={starting}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  data-testid="private-context-add-session"
                >
                  <PlayCircle className="h-3 w-3 text-muted-foreground" />
                  Session
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleAddSpec()}
                disabled={adding}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                data-testid="private-context-add-spec"
              >
                {ICON_BY_TYPE.spec &&
                  (() => {
                    const Icon = ICON_BY_TYPE.spec;
                    return <Icon className="h-3 w-3 text-muted-foreground" />;
                  })()}
                Spec
              </button>
              <button
                type="button"
                onClick={() => void handleAddSkill()}
                disabled={adding}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                data-testid="private-context-add-skill"
              >
                {ICON_BY_TYPE.skill &&
                  (() => {
                    const Icon = ICON_BY_TYPE.skill;
                    return <Icon className="h-3 w-3 text-muted-foreground" />;
                  })()}
                Skill
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
  const { data: entity } = useEntity(typeId);
  const name = entity?.displayName ?? typeId.id;
  const Icon = ICON_BY_TYPE.project ?? ExternalLink;
  return (
    <Row icon={Icon} type="Project" name={name}>
      <RowAction onClick={onOpen} title={`Open Project: ${name}`}>
        <ExternalLink className="h-3 w-3" />
        Open
      </RowAction>
    </Row>
  );
}

function PrivateTaskRow({
  task,
  originMessageIds,
  isHighlighted,
  onSelectMessages,
  onView,
  onEdit,
}: {
  task: Task;
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelectMessages?: (messageIds: string[]) => void;
  onView: () => void;
  onEdit: () => void;
}) {
  const Icon = ICON_BY_TYPE.task ?? ExternalLink;
  return (
    <Row
      icon={Icon}
      type="Task"
      name={task.displayName ?? task.id ?? '(unnamed)'}
      isHighlighted={isHighlighted}
      onFocus={
        onSelectMessages && originMessageIds.length > 0
          ? () => onSelectMessages(originMessageIds)
          : undefined
      }
      focusTitle={
        originMessageIds.length > 1
          ? `Light up the ${originMessageIds.length} messages this task is linked to`
          : 'Reveal the message this task was derived from'
      }
    >
      <RowAction onClick={onEdit} title={`Edit Task: ${task.displayName ?? ''}`}>
        <Pencil className="h-3 w-3" />
        Edit
      </RowAction>
      <RowAction onClick={onView} title={`View Task: ${task.displayName ?? ''}`}>
        <Eye className="h-3 w-3" />
        View
      </RowAction>
    </Row>
  );
}

function PrivateProcessRow({
  process,
  originMessageIds,
  isHighlighted,
  onSelectMessages,
  onView,
  onOpen,
}: {
  process: AgenticProcess;
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelectMessages?: (messageIds: string[]) => void;
  /** Read-only transcript view (lens). Disabled when there's no
   *  `session_id` yet — nothing to read until the worker has produced one. */
  onView: () => void;
  /** Live PTY terminal. */
  onOpen: () => void;
}) {
  const Icon = ICON_BY_TYPE.agentic_process ?? ExternalLink;
  const hasSession = !!process.session_id;
  return (
    <Row
      icon={Icon}
      type="Session"
      name={process.displayName ?? process.id ?? '(running)'}
      isHighlighted={isHighlighted}
      onFocus={
        onSelectMessages && originMessageIds.length > 0
          ? () => onSelectMessages(originMessageIds)
          : undefined
      }
      focusTitle={
        originMessageIds.length > 1
          ? `Light up the ${originMessageIds.length} messages this session is linked to`
          : 'Reveal the message this session was started from'
      }
    >
      <RowAction
        onClick={onView}
        disabled={!hasSession}
        title={hasSession ? 'View the session transcript' : 'No transcript yet — the worker has not produced one'}
      >
        <Eye className="h-3 w-3" />
        View
      </RowAction>
      <RowAction onClick={onOpen} title="Open the live session in a terminal">
        <ExternalLink className="h-3 w-3" />
        Open session
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
  onSelectMessages,
  onOpenTask,
}: {
  process: AgenticProcess;
  linkedTask: Task | undefined;
  originMessageIds: string[];
  isHighlighted: boolean;
  onSelectMessages?: (messageIds: string[]) => void;
  onOpenTask: () => void;
}) {
  const Icon = ICON_BY_TYPE.task ?? ExternalLink;
  const status = process.status;
  const ready = status === ProcessStatus.STOPPED || status === ProcessStatus.FAILED;
  const name =
    linkedTask?.displayName ??
    linkedTask?.id ??
    (process.displayName ? `Deriving task… (${process.displayName})` : 'Deriving task…');
  return (
    <Row
      icon={Icon}
      type="Task"
      name={name}
      isHighlighted={isHighlighted}
      onFocus={
        onSelectMessages && originMessageIds.length > 0
          ? () => onSelectMessages(originMessageIds)
          : undefined
      }
      focusTitle={
        originMessageIds.length > 1
          ? `Light up the ${originMessageIds.length} messages this task is linked to`
          : 'Reveal the message this task was derived from'
      }
    >
      <RowAction
        onClick={onOpenTask}
        disabled={!ready || !linkedTask}
        title={
          ready
            ? `Open Task: ${linkedTask?.displayName ?? ''}`
            : 'Deriving with Claude…'
        }
      >
        <ExternalLink className="h-3 w-3" />
        Open
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
      {Icon && <Icon className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
    </div>
  );
}

function ContextTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border rounded border border-border bg-background">
      {children}
    </div>
  );
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
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left transition-colors hover:bg-muted/40"
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
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={className}
    >
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
