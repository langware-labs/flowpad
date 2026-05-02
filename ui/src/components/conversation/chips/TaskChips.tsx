import { useEffect, useRef } from 'react';
import { FileText } from 'lucide-react';
import { AgenticProcess, Conversation, Project, Task, TypeId, type ProcessIconKey } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { pickProcessIcon } from '@src/components/icons/process-icons';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ContextEntityChip, EntityChip } from '../EntityChip';
import { useMyProcess } from '../useMyProcess';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey } from './keys';

interface TaskChipsProps {
  /** Task entity instance — we drive chip rendering from ``task.contextEntities``. */
  task: Task;
  conversationId: string;
  senderName?: string;
  /** Override for the project chip when no project is mapped — opens the picker. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** When the task chip is clicked, this overrides default navigation. */
  onShowTask?: () => void;
}

/**
 * Chip row for the parent Task. Driven from the unified
 * ``task.contextEntities`` getter (direct-field projection + private
 * ``_context_entities``). Iterating that list is the single source of truth
 * — adding a new entry via ``task.addContextEntity(typeId)`` automatically
 * surfaces a chip on next render.
 *
 * Special dispatch:
 * - ``agentic_process`` matching ``task.my_process_id`` → orange ProcessButton
 *   with start/open semantics (not a generic chip).
 * - ``agentic_process`` matching ``task.shared_process_id`` → suppressed here
 *   (rendered as the "Open Shared Terminal" button by ``ConversationChips``).
 * - ``project`` when the entity isn't loaded → dashed "Pick project…"
 *   placeholder that opens the project picker.
 *
 * Everything else falls through to ``<ContextEntityChip typeId={...}>``,
 * which looks up the target's display name and renders a generic
 * ``<EntityChip>``.
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
  const openOrStartRef = useRef(openOrStart);
  useEffect(() => {
    openOrStartRef.current = openOrStart;
  }, [openOrStart]);
  const { navigation } = useDockNavigation();
  const localProjectId = task.project_id ?? undefined;

  // Live-load Task + Project entity for label-aware rendering.
  const { data: taskEntity } = useEntity<Task>(
    task.id ? new TypeId(Task.type, task.id) : null,
  );
  const { data: project } = useEntity<Project>(
    localProjectId ? new TypeId(Project.type, localProjectId) : null,
  );
  // Live process — used for the icon (fresh vs restored variant).
  const { data: process } = useEntity<AgenticProcess>(
    task.my_process_id ? new TypeId(AgenticProcess.type, task.my_process_id) : null,
  );

  const conversationContainer = { type: Conversation.type, id: conversationId };

  // Self-header: the task itself, shown once at the start of the row.
  const showTaskChip = !!task.id && !exclude.has(ChipKey.task(task.id));

  const iconKey: ProcessIconKey = process ? process.icon : 'claude';
  const ProcessIcon = pickProcessIcon(iconKey);
  const claudeTooltip = isStartLabel ? 'Start Claude Code session' : 'Open Claude Code';

  // Drive the rest of the row from contextEntities. Order matches the order
  // the entity exposes (direct projections first, then the private array).
  const chips = task.contextEntities;

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

      {chips.map((typeId) => {
        const key = ChipKey.forTypeId(typeId);
        if (exclude.has(key)) return null;

        // Special: my_process_id → orange ClaudeIcon button with start/open.
        if (typeId.type === AgenticProcess.type && typeId.id === task.my_process_id) {
          if (exclude.has(ChipKey.process(task.id))) return null;
          return (
            <TooltipProvider key={key}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
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
          );
        }

        // Skip: shared_process_id is rendered by ConversationChips.
        if (typeId.type === AgenticProcess.type && typeId.id === task.shared_process_id) {
          return null;
        }

        // Special: a ``project`` entry without a loaded entity becomes the
        // dashed "Pick project…" affordance that opens the picker.
        if (typeId.type === Project.type && !project) {
          return (
            <button
              key={key}
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
          );
        }

        // Generic: spec, project (loaded), assignee/user, plan, anything new
        // added via task.addContextEntity later — all flow through here.
        const titleByType: Record<string, string> = {
          [Project.type]: 'Open this conversation under the local project',
          spec: 'Open the spec this task was created from',
        };
        return (
          <ContextEntityChip
            key={key}
            typeId={typeId}
            inside={conversationContainer}
            title={titleByType[typeId.type]}
          />
        );
      })}
    </>
  );
}
