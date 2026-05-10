import { useMemo, useState } from 'react';
import {
  AgenticProcess,
  Conversation,
  dataManager,
  FlowMessage,
  ProcessStatus,
  Task,
  TypeId,
} from '@sdk';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { useEntity } from '@sdk/react/hooks';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import {
  ExternalLink,
  Pencil,
  Plus,
  PlayCircle,
  Eye,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { fileAttachmentUrl } from './attachment-url';
import { ICON_BY_TYPE } from './EntityChip';
import { usePrivateContext } from './usePrivateContext';

interface ConversationContextPanelProps {
  flowMessage: FlowMessage | null;
  task: Task | null;
  conversation: Conversation | null;
  conversationId: string;
  /** Wraps any action that needs a `cwd`/project (still passed in case future
   *  Private Context entry types need it; currently unused here). */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
}

const TRANSCRIPT_FILENAME = 'conversation.jsonl';

function isTranscriptAttachment(a: Attachment): boolean {
  return a.attachment_type === AttachmentType.FILE && a.data.endsWith(TRANSCRIPT_FILENAME);
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
  flowMessage,
  task,
  conversation,
  conversationId,
  ensureMapped: _ensureMapped,
}: ConversationContextPanelProps) {
  if (!flowMessage) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        Select a message to view its context.
      </div>
    );
  }

  const messageId = flowMessage.id ?? '';
  const attachments: Attachment[] = flowMessage.attachment ?? [];
  const transcriptAttachment = attachments.find(isTranscriptAttachment);
  const typeIdAttachments = attachments.filter((a) => a.attachment_type === AttachmentType.TYPE_ID);

  // Lift Private Context queries here so SharedContext can hide the
  // "Start session" button once a transcript-derived session exists.
  const projectIdLifted = task?.project_id ?? conversation?.project_id ?? null;
  const { tasks: privateTasks, processes: privateProcesses } = usePrivateContext(
    messageId || null,
    projectIdLifted,
  );
  // Only visible (PTY-backed) sessions count as "transcript sessions" — invisible
  // worker processes (e.g. derive-task) live in Private Context too but should
  // not suppress the Shared Context "Start session" button.
  const hasTranscriptSession = privateProcesses.some((p) => p.visible);

  // ── Shared Context: entity TypeIds (project pinned + per-message) ────
  const skipKeys = new Set<string>();
  if (messageId) skipKeys.add(new TypeId(FlowMessage.type, messageId).toString());
  skipKeys.add(new TypeId(Conversation.type, conversationId).toString());
  if (task?.my_process_id) skipKeys.add(new TypeId(AgenticProcess.type, task.my_process_id).toString());
  if (task?.shared_process_id) skipKeys.add(new TypeId(AgenticProcess.type, task.shared_process_id).toString());

  const seen = new Set<string>();
  const sharedTypeIds: TypeId[] = [];
  const pushTypeId = (t: TypeId | null) => {
    if (!t) return;
    const key = t.toString();
    if (skipKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    sharedTypeIds.push(t);
  };
  const projectId = task?.project_id ?? conversation?.project_id ?? null;
  if (projectId) pushTypeId(new TypeId('project', projectId));
  for (const t of flowMessage.contextEntities ?? []) pushTypeId(t);
  for (const a of typeIdAttachments) {
    try {
      pushTypeId(new TypeId(a.data));
    } catch {
      /* malformed — skip */
    }
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4" data-testid="conversation-context-panel">
      <SharedContextSection
        sharedTypeIds={sharedTypeIds}
        transcriptAttachment={transcriptAttachment ?? null}
        messageId={messageId}
        conversationId={conversationId}
        hasTranscriptSession={hasTranscriptSession}
      />

      <PrivateContextSection
        flowMessage={flowMessage}
        conversationId={conversationId}
        tasks={privateTasks}
        processes={privateProcesses}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Shared Context
// ─────────────────────────────────────────────────────────────────────────

interface SharedContextSectionProps {
  sharedTypeIds: TypeId[];
  transcriptAttachment: Attachment | null;
  messageId: string;
  conversationId: string;
  /** When true, "Start session" is suppressed — a session already exists in
   *  Private Context and the user opens it from there instead. */
  hasTranscriptSession: boolean;
}

function SharedContextSection({
  sharedTypeIds,
  transcriptAttachment,
  messageId,
  conversationId,
  hasTranscriptSession,
}: SharedContextSectionProps) {
  const { navigation } = useDockNavigation();
  const containerInside = { type: Conversation.type, id: conversationId };
  const [startingCc, setStartingCc] = useState(false);

  const isEmpty = sharedTypeIds.length === 0 && !transcriptAttachment;

  const handleStartCc = async () => {
    if (!messageId || startingCc) return;
    setStartingCc(true);
    try {
      // Backend resolves transcript path + workdir + project_id; spawn happens
      // here so we get a real PTY (visible:true) the user can interact with.
      const action = new ActionInfo('start-cc-from-transcript', 'flow_message', messageId, 'POST');
      const res = await dataManager.callAction<
        unknown,
        { transcript_path?: string; workdir?: string; project_id?: string | null }
      >(action);
      if (!res?.transcript_path) {
        toast.error('Failed to resolve transcript path');
        return;
      }

      const fmTypeId = new TypeId(FlowMessage.type, messageId);
      const instruction =
        'use flow skill and provide brief analysis of this claude transcript:\n' +
        res.transcript_path;

      // Construct the entity with `target_vfs_path` set from the start so the
      // Private Context query (`match: { target_vfs_path: fm-<id> }`) catches
      // it on the CREATE event — without this the row only appears after a
      // page refresh, since the entity-event router doesn't re-evaluate
      // membership when a previously-non-matching entity flips into the
      // filter on a later UPDATE. Same pattern WorkflowAssetEditor uses.
      const cliOptions = new ClaudeCliOptions({ permission_mode: 'bypassPermissions' });
      const process = new AgenticProcess({
        cli_config: cliOptions.toJson(),
        context_data: { project_id: res.project_id ?? undefined },
        workdir: res.workdir || undefined,
        visible: true,
        project_id: res.project_id ?? undefined,
        target_vfs_path: fmTypeId.toString(),
        context_entities: [fmTypeId],
      });
      await process.save([fmTypeId]);

      // Navigate first — the dock route loader subscribes to the entity by id
      // and renders the terminal as soon as start() attaches the PTY.
      navigation.openDock(process.dockPointer);

      // Attach the PTY + send the first turn. Errors here surface in the
      // shell tab (the route is already showing it).
      await process.start({ instruction });
    } catch (err) {
      console.error('[SharedContext] start-cc-from-transcript failed', err);
      toast.error('Failed to start session');
    } finally {
      setStartingCc(false);
    }
  };

  return (
    <div>
      <SectionHeader title="Shared Context" />
      {isEmpty ? (
        <EmptyHint text="Nothing shared on this message." />
      ) : (
        <ContextTable>
          {sharedTypeIds.map((typeId) => (
            <SharedEntityRow
              key={typeId.toString()}
              typeId={typeId}
              onOpen={() => {
                const ptr = dockPointerFor(typeId, containerInside);
                if (ptr) navigation.openDock(ptr);
              }}
            />
          ))}
          {transcriptAttachment && (
            <TranscriptRow
              messageId={messageId}
              attachment={transcriptAttachment}
              startingCc={startingCc}
              onStartCc={handleStartCc}
              hasTranscriptSession={hasTranscriptSession}
            />
          )}
        </ContextTable>
      )}
    </div>
  );
}

interface SharedEntityRowProps {
  typeId: TypeId;
  onOpen: () => void;
}

function SharedEntityRow({ typeId, onOpen }: SharedEntityRowProps) {
  const { data: entity } = useEntity(typeId);
  const name = entity?.displayName ?? typeId.id;
  const Icon = ICON_BY_TYPE[typeId.type] ?? ExternalLink;
  return (
    <Row icon={Icon} type={humanType(typeId.type)} name={name}>
      <RowAction onClick={onOpen} title={`Open ${humanType(typeId.type)}: ${name}`}>
        <ExternalLink className="h-3 w-3" />
        Open
      </RowAction>
    </Row>
  );
}

interface TranscriptRowProps {
  messageId: string;
  attachment: Attachment;
  startingCc: boolean;
  onStartCc: () => void;
  hasTranscriptSession: boolean;
}

function TranscriptRow({
  messageId,
  attachment,
  startingCc,
  onStartCc,
  hasTranscriptSession,
}: TranscriptRowProps) {
  const { navigation } = useDockNavigation();
  // Prefer the agent transcript viewer when we have a local filesystem path
  // (server-populated on FILE attachments). Falls back to opening the raw
  // JSONL via the attachment-download URL — no transcript-viewer rendering,
  // but at least the user sees the bytes.
  const localPath = attachment.local_path ?? null;
  const downloadUrl = fileAttachmentUrl(messageId, attachment.data);

  const handleView = () => {
    if (localPath) {
      navigation.openLens('claude', 'transcript-path', encodeURIComponent(localPath));
    } else {
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <Row
      icon={ICON_BY_TYPE.conversation ?? ExternalLink}
      type="Transcript"
      name={attachment.data.split('/').pop() ?? attachment.data}
    >
      <RowAction
        onClick={handleView}
        title={localPath ? 'Open in the transcript viewer' : 'Open the raw JSONL in a new tab'}
      >
        <Eye className="h-3 w-3" />
        View
      </RowAction>
      {!hasTranscriptSession && (
        <RowAction
          onClick={onStartCc}
          disabled={startingCc}
          title="Start a new Claude session pre-loaded with this transcript"
        >
          <PlayCircle className="h-3 w-3" />
          {startingCc ? 'Starting…' : 'Start session'}
        </RowAction>
      )}
    </Row>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Private Context
// ─────────────────────────────────────────────────────────────────────────

interface PrivateContextSectionProps {
  flowMessage: FlowMessage;
  conversationId: string;
  tasks: Task[];
  processes: AgenticProcess[];
}

function PrivateContextSection({
  flowMessage,
  conversationId,
  tasks,
  processes,
}: PrivateContextSectionProps) {
  const { navigation } = useDockNavigation();
  const messageId = flowMessage.id ?? '';
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const handleAddTask = async () => {
    if (!messageId || adding) return;
    setShowAdd(false);
    setAdding(true);
    try {
      const action = new ActionInfo('derive-task', 'flow_message', messageId, 'POST');
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

  const containerInside = { type: Conversation.type, id: conversationId };

  // Split processes by role:
  //   - derivation workers (visible=false) — each backs a "deriving task…" row
  //     that becomes a fully-linked Task row once Claude saves the new Task.
  //   - transcript sessions (visible=true) — interactive PTYs the user opens
  //     directly via the existing PrivateProcessRow.
  const { derivationProcesses, transcriptProcesses } = useMemo(() => {
    const derivation: AgenticProcess[] = [];
    const transcript: AgenticProcess[] = [];
    for (const p of processes) {
      if (p.visible) transcript.push(p);
      else derivation.push(p);
    }
    return { derivationProcesses: derivation, transcriptProcesses: transcript };
  }, [processes]);

  // Pair each derivation process to the Task it produced (if any). Claude is
  // instructed to add the spawning AgenticProcess's TypeId to the new Task's
  // context_entities so we can match them here.
  const linkedTaskByProcessId = useMemo(() => {
    const map = new Map<string, Task>();
    for (const p of derivationProcesses) {
      if (!p.id) continue;
      const procKey = new TypeId(AgenticProcess.type, p.id).toString();
      const linked = tasks.find((t) =>
        t.contextEntities?.some((tid) => tid.toString() === procKey),
      );
      if (linked) map.set(p.id, linked);
    }
    return map;
  }, [derivationProcesses, tasks]);

  // Tasks already represented by a paired derivation row are hidden from the
  // standalone list to avoid showing the same derivation twice.
  const standaloneTasks = useMemo(() => {
    const pairedTaskIds = new Set(
      Array.from(linkedTaskByProcessId.values())
        .map((t) => t.id)
        .filter((id): id is string => !!id),
    );
    return tasks.filter((t) => !t.id || !pairedTaskIds.has(t.id));
  }, [tasks, linkedTaskByProcessId]);

  const isEmpty =
    standaloneTasks.length === 0 &&
    derivationProcesses.length === 0 &&
    transcriptProcesses.length === 0;

  return (
    <div>
      <SectionHeader
        title="Private Context"
        action={
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowAdd((v) => !v)}
              disabled={adding}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              title="Add to private context"
              data-testid="private-context-add"
            >
              <Plus className="h-3 w-3" />
            </button>
            {showAdd && (
              <div className="absolute right-0 top-full z-10 mt-1 min-w-[140px] rounded-md border border-border bg-popover p-1 text-xs shadow-md">
                <button
                  type="button"
                  onClick={() => void handleAddTask()}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-foreground transition-colors hover:bg-muted"
                >
                  {ICON_BY_TYPE.task &&
                    (() => {
                      const Icon = ICON_BY_TYPE.task;
                      return <Icon className="h-3 w-3 text-muted-foreground" />;
                    })()}
                  Task
                </button>
              </div>
            )}
          </div>
        }
      />
      {isEmpty ? (
        <EmptyHint text="Nothing added yet. Use the + to add a task." />
      ) : (
        <ContextTable>
          {standaloneTasks.map((t) => (
            <PrivateTaskRow
              key={t.id}
              task={t}
              onView={() => {
                if (!t.typeId) return;
                const ptr = dockPointerFor(t.typeId, containerInside);
                if (ptr) navigation.openDock(ptr);
              }}
              onEdit={() => {
                if (!t.id) return;
                navigation.openDock(DockPointer.forTasks(t.id, { conversationId }));
              }}
            />
          ))}
          {derivationProcesses.map((p) => {
            const linkedTask = p.id ? linkedTaskByProcessId.get(p.id) : undefined;
            return (
              <PrivateDerivationRow
                key={p.id}
                process={p}
                linkedTask={linkedTask}
                onOpenTask={() => {
                  if (!linkedTask?.id) return;
                  navigation.openDock(
                    DockPointer.forTasks(linkedTask.id, { conversationId }),
                  );
                }}
              />
            );
          })}
          {transcriptProcesses.map((p) => (
            <PrivateProcessRow
              key={p.id}
              process={p}
              onOpen={() => {
                if (p.dockPointer) navigation.openDock(p.dockPointer);
              }}
            />
          ))}
        </ContextTable>
      )}
    </div>
  );
}

function PrivateTaskRow({
  task,
  onView,
  onEdit,
}: {
  task: Task;
  onView: () => void;
  onEdit: () => void;
}) {
  const Icon = ICON_BY_TYPE.task ?? ExternalLink;
  return (
    <Row icon={Icon} type="Task" name={task.displayName ?? task.id ?? '(unnamed)'}>
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
  onOpen,
}: {
  process: AgenticProcess;
  onOpen: () => void;
}) {
  const Icon = ICON_BY_TYPE.agentic_process ?? ExternalLink;
  return (
    <Row
      icon={Icon}
      type="Session"
      name={process.displayName ?? process.id ?? '(running)'}
    >
      <RowAction onClick={onOpen} title="Open the session">
        <ExternalLink className="h-3 w-3" />
        Open
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
  onOpenTask,
}: {
  process: AgenticProcess;
  linkedTask: Task | undefined;
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
    <Row icon={Icon} type="Task" name={name}>
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

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      {action}
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
  children,
}: {
  icon: LucideIcon;
  type: string;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{type}</span>
      <span
        className="min-w-0 flex-1 truncate text-foreground"
        title={name}
      >
        {name}
      </span>
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
