import { useEffect, useRef } from 'react';
import { FileText } from 'lucide-react';
import { AgenticProcess, Conversation, Project, Spec, Task, TypeId, type ProcessIconKey } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { pickProcessIcon } from '@src/components/icons/process-icons';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { EntityChip } from '../EntityChip';
import { useMyProcess } from '../useMyProcess';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey } from './keys';

interface TaskChipsProps {
  task: ITask;
  conversationId: string;
  senderName?: string;
  /** Override for the project chip when no project is mapped — opens the picker. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** When the task chip is clicked, this overrides default navigation. */
  onShowTask?: () => void;
}

/**
 * Chip row for the parent Task: project, spec, and the per-task Claude /
 * AgenticProcess button. Anything already shown at a higher level (none
 * today; reserved for future) is suppressed via ``ChipsExcludeContext``.
 */
export function TaskChips({
  task,
  conversationId,
  senderName,
  ensureMapped,
  onShowTask,
}: TaskChipsProps) {
  const exclude = useChipsExclude();
  const { isStartLabel, busy, openOrStart } = useMyProcess({ task, conversationId, senderName });
  // Keep a ref pointing at the *latest* openOrStart so the project-mapping
  // gate's continuation reads fresh task.metadata after the user picks.
  const openOrStartRef = useRef(openOrStart);
  useEffect(() => {
    openOrStartRef.current = openOrStart;
  }, [openOrStart]);
  const { navigation } = useDockNavigation();
  const localProjectId = task.project_id ?? undefined;

  const { data: project } = useEntity<Project>(
    localProjectId ? new TypeId(Project.type, localProjectId) : null,
  );
  const { data: taskEntity } = useEntity<Task>(
    task.id ? new TypeId(Task.type, task.id) : null,
  );
  const { data: spec } = useEntity<Spec>(
    task.spec_id ? new TypeId(Spec.type, task.spec_id) : null,
  );
  // Live process — used for icon selection so the glyph reflects fresh-vs-restored.
  const { data: process } = useEntity<AgenticProcess>(
    task.my_process_id ? new TypeId(AgenticProcess.type, task.my_process_id) : null,
  );

  const conversationContainer = { type: Conversation.type, id: conversationId };

  const showTaskChip = !!task.id && !exclude.has(ChipKey.task(task.id));
  const showProjectChip = !exclude.has(ChipKey.project(localProjectId));
  const showSpecChip = !!task.spec_id && !exclude.has(ChipKey.spec(task.spec_id));
  const showProcessButton = !!task.id && !exclude.has(ChipKey.process(task.id));

  // Process button: icon comes from AgenticProcess.icon when we have a live
  // process, otherwise default to ClaudeIcon (the "start fresh" affordance).
  const iconKey: ProcessIconKey = process ? process.icon : 'claude';
  const ProcessIcon = pickProcessIcon(iconKey);
  const claudeTooltip = isStartLabel ? 'Start Claude Code session' : 'Open Claude Code';

  return (
    <>
      {showTaskChip && taskEntity && (
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
          the user set one up *before* they actually need it. */}
      {showProjectChip && (project ? (
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
      ))}

      {showSpecChip && (
        <EntityChip
          entity={{
            typeId: new TypeId(Spec.type, task.spec_id!),
            type: Spec.type,
            id: task.spec_id,
            name: spec?.title ?? 'Spec',
          }}
          title="Open the spec this task was created from"
        />
      )}

      {showProcessButton && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  // Read fresh openOrStart at call time so a post-mapping
                  // continuation runs against fresh task.metadata.
                  const action = () => openOrStartRef.current();
                  if (ensureMapped) ensureMapped(action);
                  else void action();
                }}
                disabled={busy}
                aria-label={claudeTooltip}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-orange-500 transition-colors hover:bg-orange-500/10 disabled:opacity-50"
              >
                {ProcessIcon ? (
                  <ProcessIcon className="h-3.5 w-3.5" />
                ) : (
                  <ClaudeIcon className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              {busy ? 'Starting…' : claudeTooltip}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </>
  );
}
