import { useMemo, useState } from 'react';
import {
  AgenticProcess,
  Conversation,
  dataManager,
  FlowMessage,
  ProcessStatus,
  Spec,
  Task,
  TypeId,
} from '@sdk';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { ClaudeCliOptions } from '@sdk/cli_workers/claude-cli';
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
import { buildReceiverContextPrompt } from './useMyProcess';

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
  ensureMapped,
}: ConversationContextPanelProps) {
  // ⚠ All hook calls must come BEFORE the early-return. Skipping a hook on
  // the "no message" branch corrupts React's hook table — manifests as the
  // "Expected static flag was missing" warning and stale state cascading
  // into child queries (which can in turn open the wrong session).
  const messageId = flowMessage?.id ?? '';
  const attachments: Attachment[] = flowMessage?.attachment ?? [];
  const transcriptAttachment = attachments.find(isTranscriptAttachment);
  const typeIdAttachments = attachments.filter((a) => a.attachment_type === AttachmentType.TYPE_ID);

  // Lift Private Context queries here so SharedContext can hide the
  // "Start session" button once a transcript-derived session exists.
  const projectIdLifted = task?.project_id ?? conversation?.project_id ?? null;
  const { tasks: privateTasks, processes: privateProcesses, processesLoaded } = usePrivateContext(
    messageId || null,
    projectIdLifted,
  );
  // Only visible (PTY-backed) sessions count as "transcript sessions" — invisible
  // worker processes (e.g. derive-task) live in Private Context too but should
  // not suppress the Shared Context "Start session" button.
  const hasTranscriptSession = privateProcesses.some((p) => p.visible);
  const showStartSession = processesLoaded && !hasTranscriptSession;

  if (!flowMessage) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
        Select a message to view its context.
      </div>
    );
  }

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
        showStartSession={showStartSession}
        task={task}
        flowMessage={flowMessage}
        senderName={task?.sender_name ?? undefined}
        ensureMapped={ensureMapped}
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
  /** True only after the Private Context query has resolved AND there is no
   *  existing PTY session. False both during the initial query and once a
   *  session exists — either case must hide the button. */
  showStartSession: boolean;
  task: Task | null;
  flowMessage: FlowMessage | null;
  senderName?: string;
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
}

function SharedContextSection({
  sharedTypeIds,
  transcriptAttachment,
  messageId,
  conversationId,
  showStartSession,
  task,
  flowMessage,
  senderName,
  ensureMapped,
}: SharedContextSectionProps) {
  const { navigation } = useDockNavigation();
  const containerInside = { type: Conversation.type, id: conversationId };
  const [startingCc, setStartingCc] = useState(false);

  const isEmpty = sharedTypeIds.length === 0 && !transcriptAttachment;

  // Identify the spec TypeId in shared context (if any). When present, the
  // "Start session" action lives on the spec row; otherwise it lives on the
  // transcript row. One-session-per-message either way — `hasTranscriptSession`
  // hides the action once a session lands in Private Context.
  const specTypeId = sharedTypeIds.find((t) => t.type === Spec.type) ?? null;

  /**
   * Unified Start session handler used by both the spec row and the transcript
   * row. Basic primitive flow per `docs/agent-management/agentic-process.md`:
   *
   *   1. `new AgenticProcess({ ..., context_entities: [FM TypeId string] })`
   *      — set the FlowMessage linkage up-front so the very first save persists
   *      it (the constructor's `fromWire` path moves it into `_context_entities`
   *      before any save runs).
   *   2. `.save()` — persists the entity *with* the FlowMessage linkage so
   *      `usePrivateContext`'s `contextEntities` filter immediately sees it.
   *      The backend's WS create message subsequently re-runs watched queries
   *      via the `store.ts:387-399` create handler, which is what makes the
   *      new row appear in Private Context.
   *   3. `.start({ instruction })` — opens the PTY and injects the receiver
   *      context prompt (spec content if present, transcript path, conversation
   *      messages, attachment paths, context-entity metadata paths). This is a
   *      ~hundreds-of-ms network round-trip, giving React plenty of time to
   *      paint the new Private Context row before step 4.
   *   4. `.openTerminalDock()` — navigates to `/dock/shell/agentic_process-<id>`.
   */
  const handleStartSession = async () => {
    if (!messageId || startingCc || !task || !flowMessage) return;
    const workdir = task.project_root ?? undefined;
    if (!workdir) {
      toast.warning('Map this conversation to a local project first.');
      return;
    }
    setStartingCc(true);
    try {
      const instruction = await buildReceiverContextPrompt(task, conversationId, senderName);

      // Set `context_entities` up-front in the constructor — the APIEntity
      // base (APIEntity.ts:339-345 `fromWire` path) moves wire-shaped
      // context_entities into the private `_context_entities` slot before the
      // first save, so a single .save() persists the FlowMessage linkage along
      // with the rest of the entity. The previous two-save approach
      // (`new+save` → `addContextEntity` → `save`) didn't survive page reload
      // — the second save's dirty-tracking failed to include `_context_entities`
      // in the patch, leaving the FlowMessage linkage local-only.
      const fmTypeIdString = new TypeId(FlowMessage.type, messageId).toString();
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
      console.error('[SharedContext] start session failed', err);
      toast.error('Failed to start session');
    } finally {
      setStartingCc(false);
    }
  };

  // Legacy transcript-only fallback when there's no task to drive the
  // receiver-context prompt (rare — project-scoped conversations). Uses the
  // server-side `start-cc-from-transcript` action and a minimal instruction.
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

      // Use AgenticProcess.spawn — the same path useMyProcess uses for
      // "Open Claude Code" (which works). Spawning manually then calling start()
      // raced with the dock route loader's own loadProcess→start, causing the
      // loader to throw and fall back to the user's existing my_process_id
      // (the "wrong session opens" symptom).
      //
      // Linkage to the source FlowMessage goes through context_entities, added
      // via the public API after spawn (the constructor's deepAssign would
      // strip the TypeId prototype if we passed it through). The Private
      // Context query filters AgenticProcesses client-side on this — same
      // pattern Tasks already use.
      // Bullet-proof flow: spawn (PTY + instruction injected) + link to the
      // FlowMessage. Deliberately NO auto-navigate — the dock route loader
      // independently calls loadProcess → start(visible:true) on whatever id
      // is in the URL, which races with the spawn and sends the user to
      // their previous my_process_id when the loader bails. The row appears
      // in Private Context; the user clicks Open there to view the session.
      const { process } = await AgenticProcess.spawn(
        {
          permissionMode: 'bypassPermissions',
          workdir: res.workdir || undefined,
          projectId: res.project_id ?? undefined,
        },
        { instruction, visible: true },
      );
      process.addContextEntity(fmTypeId);
      await process.save();
      // Diagnostic: verify the link persisted. If `contextEntities` doesn't
      // contain the fm typeId after save, the server isn't accepting the
      // update and the row will never appear.
      const persisted = process.contextEntities?.some((t) => t.toString() === fmTypeId.toString());
      console.log('[start-cc-from-transcript] spawned process', {
        id: process.id,
        project_id: process.project_id,
        contextEntities: process.contextEntities?.map((t) => t.toString()),
        linkPersisted: persisted,
      });
      toast.success('Session started — open it from Private Context below.');
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
          {sharedTypeIds.map((typeId) => {
            const isSpec = typeId.type === Spec.type;
            // Start session lives on the spec row when a spec is present.
            const handleStart =
              isSpec && task && flowMessage && showStartSession
                ? () => {
                    const action = () => handleStartSession();
                    if (ensureMapped) ensureMapped(action);
                    else void action();
                  }
                : undefined;
            return (
              <SharedEntityRow
                key={typeId.toString()}
                typeId={typeId}
                onOpen={() => {
                  const ptr = dockPointerFor(typeId, containerInside);
                  if (ptr) navigation.openDock(ptr);
                }}
                onStartSession={handleStart}
                starting={isSpec ? startingCc : false}
              />
            );
          })}
          {transcriptAttachment && (
            <TranscriptRow
              messageId={messageId}
              attachment={transcriptAttachment}
              startingCc={startingCc}
              // When a spec is present, the spec row owns Start session — so
              // we hide it on the transcript row to avoid two buttons doing
              // the same thing.
              onStartCc={
                specTypeId
                  ? null
                  : (task && flowMessage
                      ? () => {
                          const action = () => handleStartSession();
                          if (ensureMapped) ensureMapped(action);
                          else void action();
                        }
                      : handleStartCc)
              }
              showStartSession={showStartSession}
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
  /** When set, renders a "Start session" action alongside View. Currently
   *  only the spec row uses this — clicking spawns a Claude Code session
   *  pre-loaded with the receiver context prompt (see SharedContextSection
   *  `handleStartSession`). */
  onStartSession?: () => void;
  starting?: boolean;
}

function SharedEntityRow({ typeId, onOpen, onStartSession, starting }: SharedEntityRowProps) {
  const { data: entity } = useEntity(typeId);
  const name = entity?.displayName ?? typeId.id;
  const Icon = ICON_BY_TYPE[typeId.type] ?? ExternalLink;
  // Spec rows say "View" (they open in the Milkdown editor — see
  // DockPointer.forSpec → /dock/spec/<id>); everything else stays "Open".
  const isSpec = typeId.type === Spec.type;
  const primaryLabel = isSpec ? 'View' : 'Open';
  const primaryIcon = isSpec ? <Eye className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />;
  return (
    <Row icon={Icon} type={humanType(typeId.type)} name={name}>
      <RowAction onClick={onOpen} title={`${primaryLabel} ${humanType(typeId.type)}: ${name}`}>
        {primaryIcon}
        {primaryLabel}
      </RowAction>
      {onStartSession && !starting && (
        <RowAction
          onClick={onStartSession}
          title="Start a Claude Code session pre-loaded with this spec and conversation context"
        >
          <PlayCircle className="h-3 w-3" />
          Start session
        </RowAction>
      )}
    </Row>
  );
}

interface TranscriptRowProps {
  messageId: string;
  attachment: Attachment;
  startingCc: boolean;
  /** `null` suppresses the Start session button entirely (e.g. when a spec
   *  row owns it instead). Otherwise rendered when `showStartSession` is true. */
  onStartCc: (() => void) | null;
  showStartSession: boolean;
}

function TranscriptRow({
  messageId,
  attachment,
  startingCc,
  onStartCc,
  showStartSession,
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
    >
      <RowAction
        onClick={handleView}
        title={localPath ? 'Open in the transcript viewer' : 'Open the raw JSONL in a new tab'}
      >
        <Eye className="h-3 w-3" />
        View
      </RowAction>
      {showStartSession && !startingCc && onStartCc && (
        <RowAction
          onClick={onStartCc}
          title="Start a new Claude session pre-loaded with this transcript"
        >
          <PlayCircle className="h-3 w-3" />
          Start session
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
              onView={() => {
                // Transcript lens (read-only) — `transcriptDockPointer`
                // routes to `/dock/lens/<worker>/transcript/<session_id>`.
                if (p.transcriptDockPointer) navigation.openDock(p.transcriptDockPointer);
              }}
              onOpen={() => {
                // Live PTY — `terminalDockPointer` routes to
                // `/dock/shell/agentic_process-<id>`.
                if (p.terminalDockPointer) navigation.openDock(p.terminalDockPointer);
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
  onView,
  onOpen,
}: {
  process: AgenticProcess;
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
