import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { AgenticProcess, Conversation, dataManager, Project, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useMyProcess } from './useMyProcess';
import { EntityChip } from './EntityChip';
import { fileAttachmentUrl } from './attachment-url';
import {
  findConversationTranscript,
  type ConversationTranscriptInfo,
} from './find-conversation-transcript';

interface ConversationToolbarProps {
  task: ITask;
  conversationId: string;
  senderName?: string;
  /**
   * Optional override for the "Open Task" button. When omitted (default),
   * the button navigates to `/dock/tasks/<taskId>/conversation/<convId>` —
   * the canonical anchor for this task + conversation pair.
   */
  onShowTask?: () => void;
  /** Wraps any action that needs a `cwd`/project. When unmapped, the parent will pop the mapping dialog and resume the action after the user picks. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
}

/**
 * Sits next to the "Conversation" header. Hosts the per-conversation actions
 * (Open Task, Transcript File, Claude Code) that used to live as per-message
 * chips. Stays out of MessageActionChips so each bubble doesn't duplicate them.
 */
export function ConversationToolbar({
  task,
  conversationId,
  senderName,
  onShowTask,
  ensureMapped,
}: ConversationToolbarProps) {
  const [transcript, setTranscript] = useState<ConversationTranscriptInfo | null>(null);
  const { isStartLabel, busy, openOrStart } = useMyProcess({ task, conversationId, senderName });
  // Keep a ref pointing at the *latest* openOrStart so an action stored on
  // the project-mapping gate's continuation reads the freshest task fields
  // (and not whatever was current at click time). Without this, the cont
  // captured before the user picks a project still calls the pre-mapping
  // openOrStart and ends up with project_root undefined.
  const openOrStartRef = useRef(openOrStart);
  useEffect(() => {
    openOrStartRef.current = openOrStart;
  }, [openOrStart]);
  const { navigation } = useDockNavigation();
  const localProjectId = task.project_id ?? undefined;

  // Live-load the Project / Task entities for EntityChip display. Both are
  // optional — the label still renders the id as a fallback name when the
  // entity isn't loaded yet.
  const { data: project } = useEntity<Project>(
    localProjectId ? new TypeId(Project.type, localProjectId) : null,
  );
  const { data: taskEntity } = useEntity<Task>(
    task.id ? new TypeId(Task.type, task.id) : null,
  );

  const conversationContainer = useMemo(
    () => ({ type: Conversation.type, id: conversationId }),
    [conversationId],
  );

  // Find the first conversation.jsonl FILE attachment across all messages.
  useEffect(() => {
    let cancelled = false;
    void findConversationTranscript(conversationId).then((info) => {
      if (!cancelled) setTranscript(info);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const showTaskLabel = !!task.id;
  const claudeTooltip = isStartLabel ? 'Start Claude Code session' : 'Open Claude Code';
  const sharedProcessId = task.shared_process_id ?? undefined;
  const showSharedTerminal = !!sharedProcessId;

  const handleOpenShared = async () => {
    if (!sharedProcessId) return;
    const proc = await dataManager
      .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, sharedProcessId))
      .catch(() => null);
    if (!proc) return;
    navigation.openDock(proc.dockPointer);
  };

  return (
    <div className="flex items-center gap-1">
      {showTaskLabel && taskEntity && (
        <EntityChip
          entity={{
            typeId: new TypeId(Task.type, task.id ?? ''),
            type: Task.type,
            id: task.id,
            name: taskEntity.title ?? task.title,
          }}
          inside={conversationContainer}
          onClick={onShowTask}
          title="Open this task"
        />
      )}

      {/* Project chip — once a project is mapped we render the standard
          EntityChip; otherwise a passive dashed "Pick project…" chip lets
          the user set one up *before* they actually need it. Either chip is
          a preparation affordance, not an urgent prompt — when an action
          *requires* a project (Open Claude Code, Approve & Execute, Open in
          Project, etc.) the gate pops the picker dialog via ensureMapped. */}
      {project ? (
        <EntityChip
          entity={{
            typeId: new TypeId(Project.type, project.id ?? ''),
            type: Project.type,
            id: project.id,
            name: project.name ?? localProjectId,
          }}
          inside={conversationContainer}
          title="Open this conversation under the local project"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            const action = () => {
              // Re-read fresh from the task in case the picker just stamped it.
              const projId = task.project_id ?? localProjectId;
              if (!projId) return;
              navigation.openDock(DockPointer.forProject(projId, { conversationId }));
            };
            if (ensureMapped) ensureMapped(action);
            else if (localProjectId) action();
          }}
          title="Open this conversation under the local project"
          className="inline-flex h-6 items-center gap-1 rounded border border-dashed border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FileText className="h-3 w-3" />
          Pick project…
        </button>
      )}

      {transcript && (
        <a
          href={fileAttachmentUrl(transcript.messageId, transcript.vfsPath)}
          target="_blank"
          rel="noreferrer"
          download
          title="Download sender's Claude Code transcript"
          className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FileText className="h-3 w-3" />
          Transcript File
        </a>
      )}

      {/* Open Shared Terminal — appears once any prompt has been approved
          (i.e. shared_process_id is stamped on the task). One conversation-
          level chip instead of N per-message ones. */}
      {showSharedTerminal && (
        <button
          type="button"
          onClick={() => void handleOpenShared()}
          title="Open the shared terminal where approved prompts run"
          className="inline-flex h-6 items-center gap-1 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 text-[11px] font-medium text-orange-700 transition-colors hover:bg-orange-500/20 dark:text-orange-300"
        >
          <ClaudeIcon className="h-3 w-3" />
          Open Shared Terminal
        </button>
      )}

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                // Read the latest openOrStart at call time via the ref so a
                // post-mapping continuation runs against fresh task fields.
                const action = () => openOrStartRef.current();
                if (ensureMapped) ensureMapped(action);
                else void action();
              }}
              disabled={busy}
              aria-label={claudeTooltip}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-orange-500 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
            >
              <ClaudeIcon className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            {busy ? 'Starting…' : claudeTooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
