import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import { AgenticProcess, Conversation, Project, Task, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ContextEntityChip, EntityChip } from '../EntityChip';
import { useChipsExclude } from './ChipsExcludeContext';
import { ChipKey, mergeContextBuckets } from './keys';

interface TaskChipsProps {
  /** Task entity instance — we drive chip rendering from both
   *  ``task.sharedContextEntities`` and ``task.privateContextEntities``
   *  (merged via ``mergeContextBuckets``). */
  task: Task;
  conversationId: string;
  /** Override for the project chip when no project is mapped — opens the picker. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
  /** When the task chip is clicked, this overrides default navigation. */
  onShowTask?: () => void;
}

/**
 * Chip row for the parent Task. Driven from both context buckets shipped
 * by the backend:
 *   * ``sharedContextEntities`` — wire-published links (specs,
 *     conversations, spawned children).
 *   * ``privateContextEntities`` — implicit projections (project_id) plus
 *     explicit attachments, merged and deduped server-side via
 *     ``Entity.get_implicit_private_context_entities`` +
 *     ``private_context_entities`` computed_field. The FE renders the
 *     arrays as-is; it never combines or mutates context locally.
 *
 * Iterating both arrays is the single source of truth — adding context
 * always goes through a backend action (``share-context`` for shared,
 * any future private-mutation action for private). A new chip appears on
 * the next WS broadcast.
 *
 * Special dispatch:
 * - ``agentic_process`` matching ``task.my_process_id`` → suppressed here; the
 *   "Open Claude" affordance now lives in the conversation's Context drawer
 *   tab (``OpenInClaudeButton``), not the toolbar.
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
  ensureMapped,
  onShowTask,
}: TaskChipsProps) {
  const exclude = useChipsExclude();
  const { navigation } = useDockNavigation();
  const localProjectId = task.project_id ?? undefined;

  // Live-load Task + Project entity for label-aware rendering.
  const { data: taskEntity } = useEntity<Task>(
    task.id ? new TypeId(Task.type, task.id) : null,
  );
  const { data: project } = useEntity<Project>(
    localProjectId ? new TypeId(Project.type, localProjectId) : null,
  );

  const conversationContainer = useMemo(
    () => ({ type: Conversation.type, id: conversationId }),
    [conversationId],
  );

  const showTaskChip = !!task.id && !exclude.has(ChipKey.task(task.id));

  const chips = useMemo(
    () => mergeContextBuckets(task),
    [task.sharedContextEntities, task.privateContextEntities],
  );

  return (
    <>
      {showTaskChip && taskEntity && (
        <EntityChip
          entity={{
            typeId: new TypeId(Task.type, task.id ?? ''),
            type: Task.type,
            id: task.id,
            name: taskEntity.displayName,
          }}
          inside={conversationContainer}
          onClick={onShowTask}
        />
      )}

      {chips.map((typeId) => {
        const key = ChipKey.forTypeId(typeId);
        if (exclude.has(key)) return null;

        // Skip: my_process_id is rendered above as the orange ProcessButton —
        // don't render a second generic chip for the same process.
        if (typeId.type === AgenticProcess.type && typeId.id === task.my_process_id) {
          return null;
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

        // Generic: spec, project (loaded), plan, or anything else that
        // arrived in either bucket from the backend. New attachments flow
        // through here automatically once the WS broadcast updates the
        // entity. Tooltip falls back to EntityChip's default
        // "Open <Type>: <name>".
        return (
          <ContextEntityChip
            key={key}
            typeId={typeId}
            inside={conversationContainer}
          />
        );
      })}
    </>
  );
}
