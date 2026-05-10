import { useState } from 'react';
import {
  AgenticProcess,
  Conversation,
  dataManager,
  FlowMessage,
  Task,
  TypeId,
} from '@sdk';
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
import { ICON_BY_TYPE } from './EntityChip';
import { OpenInClaudeButton } from './OpenInClaudeButton';
import { usePrivateContext } from './usePrivateContext';

interface ConversationContextPanelProps {
  flowMessage: FlowMessage | null;
  task: Task | null;
  conversation: Conversation | null;
  conversationId: string;
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
      {task && (
        <div>
          <SectionHeader title="Open in Claude" />
          <OpenInClaudeButton
            task={task}
            conversationId={conversationId}
            ensureMapped={ensureMapped}
            variant="inline"
          />
        </div>
      )}

      <SharedContextSection
        sharedTypeIds={sharedTypeIds}
        transcriptAttachment={transcriptAttachment ?? null}
        messageId={messageId}
        conversationId={conversationId}
      />

      <PrivateContextSection
        flowMessage={flowMessage}
        projectId={projectId ?? null}
        conversationId={conversationId}
        transcriptAttachment={transcriptAttachment ?? null}
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
}

function SharedContextSection({
  sharedTypeIds,
  transcriptAttachment,
  messageId,
  conversationId,
}: SharedContextSectionProps) {
  const { navigation } = useDockNavigation();
  const containerInside = { type: Conversation.type, id: conversationId };
  const [startingCc, setStartingCc] = useState(false);

  const isEmpty = sharedTypeIds.length === 0 && !transcriptAttachment;

  const handleStartCc = async () => {
    if (!messageId || startingCc) return;
    setStartingCc(true);
    try {
      const action = new ActionInfo('start-cc-from-transcript', 'flow_message', messageId, 'POST');
      const res = await dataManager.callAction<unknown, { process_id?: string }>(action);
      if (res?.process_id) {
        toast.success('Starting Claude session from transcript…');
      } else {
        toast.error('Failed to start Claude session');
      }
    } catch (err) {
      console.error('[SharedContext] start-cc-from-transcript failed', err);
      toast.error('Failed to start Claude session');
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
}

function TranscriptRow({ messageId, attachment, startingCc, onStartCc }: TranscriptRowProps) {
  // The transcript URL is the FlowMessage attachment download endpoint;
  // opening in a new tab gives the user the raw JSONL. The richer
  // ClaudeTranscriptViewer requires a discoverable session-id, which an
  // attached transcript doesn't have until "Start CC" creates a session.
  const url = `/api/v1/graph/fs/flow_message/${messageId}/download/${attachment.data}`;
  return (
    <Row
      icon={ICON_BY_TYPE.conversation ?? ExternalLink}
      type="Transcript"
      name={attachment.data.split('/').pop() ?? attachment.data}
    >
      <RowAction
        as="a"
        href={url}
        target="_blank"
        rel="noreferrer"
        title="Open the Claude Code transcript in a new tab"
      >
        <Eye className="h-3 w-3" />
        View CC session
      </RowAction>
      <RowAction
        onClick={onStartCc}
        disabled={startingCc}
        title="Start a new Claude session pre-loaded with this transcript"
      >
        <PlayCircle className="h-3 w-3" />
        {startingCc ? 'Starting…' : 'Start CC session'}
      </RowAction>
    </Row>
  );
}

// ─────────────────────────────────────────────────────────────────────────
//  Private Context
// ─────────────────────────────────────────────────────────────────────────

interface PrivateContextSectionProps {
  flowMessage: FlowMessage;
  projectId: string | null;
  conversationId: string;
  transcriptAttachment: Attachment | null;
}

function PrivateContextSection({
  flowMessage,
  projectId,
  conversationId,
}: PrivateContextSectionProps) {
  const { navigation } = useDockNavigation();
  const messageId = flowMessage.id ?? '';
  const { tasks, processes } = usePrivateContext(messageId || null, projectId);
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

  const isEmpty = tasks.length === 0 && processes.length === 0;

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
          {tasks.map((t) => (
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
          {processes.map((p) => (
            <PrivateProcessRow
              key={p.id}
              process={p}
              onView={() => {
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
  onView,
}: {
  process: AgenticProcess;
  onView: () => void;
}) {
  const Icon = ICON_BY_TYPE.agentic_process ?? ExternalLink;
  return (
    <Row
      icon={Icon}
      type="CC Session"
      name={process.displayName ?? process.id ?? '(running)'}
    >
      <RowAction onClick={onView} title="Open the CC session">
        <Eye className="h-3 w-3" />
        View
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
