import { useMemo } from 'react';
import { Conversation, type Task, TypeId } from '@sdk';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { ConversationToolbar } from './ConversationToolbar';
import { ConversationView } from './ConversationView';
import { useProjectMappingGate } from './useProjectMappingGate';
import { ChipsExcludeProvider } from './chips/ChipsExcludeContext';
import { ChipKey, taskChipKeys } from './chips/keys';

interface ConversationPanelProps {
  /** Optional. Project-scoped conversations have no task. */
  task?: Task | null;
  conversationId: string;
  /** Optional sender label for messages whose `sender_name` field is missing. */
  senderName?: string;
  /**
   * Override the "Conversation" header label. Pass `null` to suppress the
   * label entirely (the toolbar still renders). Default: "Conversation".
   */
  headerLabel?: string | null;
  /**
   * Visual density. `compact` matches the inline TaskDetailPanel layout;
   * `default` matches the SharedTaskView layout.
   */
  variant?: 'default' | 'compact';
  className?: string;
}

/**
 * Single source of truth for how a conversation looks anywhere in the app.
 *
 * Layout (top to bottom):
 *   [ "Conversation" header  +  ConversationToolbar (Open Task / Transcript / CC) ]
 *   [ ConversationView (avatars, bubbles, prompt rows, composer) ]
 *
 * Owns its own project-picker dialog (the same `OpenProjectComponent` the
 * footer uses) so callers don't have to plumb it. The active-project context
 * is set by the route loaders (`load-conversation`, `load-tasks`,
 * `load-project`) before this component renders — no need for a runtime
 * sync hook here.
 *
 * The "Open Task" button in the toolbar navigates to
 * `/dock/tasks/<taskId>/conversation/<convId>` — a canonical URL anchor for
 * the task + conversation pair. Drop the panel anywhere a task-bound
 * conversation needs to render — task views, the inbox reader, embedded
 * panels.
 */
export function ConversationPanel({
  task,
  conversationId,
  senderName,
  headerLabel = 'Conversation',
  variant = 'default',
  className,
}: ConversationPanelProps) {
  // Project-scoped conversations skip the project-mapping gate entirely.
  const mappingGate = useProjectMappingGate(task ?? undefined);
  const ensureMapped = task ? mappingGate.ensureMapped : undefined;
  const mappingDialogProps = mappingGate.dialogProps;

  // Seed the chip-exclude scope with what TaskChips will render so deeper
  // chip rows (MessageChips) skip duplicates automatically.
  const taskKeys = useMemo(() => taskChipKeys(task ?? null), [task]);
  // The conversation we are SHOWING is the page subject — never render a
  // chip for ourselves. Add it to the exclude scope at the toolbar level so
  // the data-driven TaskChips iteration over ``task.contextEntities`` skips
  // the matching conversation entry.
  const selfPageKeys = useMemo(
    () => new Set([ChipKey.forTypeId(new TypeId(Conversation.type, conversationId))]),
    [conversationId],
  );

  const headerWrapper =
    variant === 'compact'
      ? 'flex items-center gap-1.5 text-xs font-medium text-muted-foreground'
      : 'flex h-9 flex-shrink-0 items-center gap-2 border-y border-border px-4 text-xs font-medium text-muted-foreground';
  const bodyWrapper = variant === 'compact' ? 'mt-1' : 'px-4 pt-3';

  return (
    <div className={className}>
      {(headerLabel !== null || ensureMapped) && (
        <div className={headerWrapper}>
          {headerLabel !== null && <span>{headerLabel}</span>}
          {task && (
            <ChipsExcludeProvider add={selfPageKeys}>
              <ConversationToolbar
                task={task}
                conversationId={conversationId}
                senderName={senderName}
                ensureMapped={ensureMapped}
              />
            </ChipsExcludeProvider>
          )}
        </div>
      )}
      <div className={bodyWrapper}>
        <ChipsExcludeProvider add={taskKeys}>
          <ConversationView
            conversationId={conversationId}
            task={task}
            senderName={senderName}
            ensureMapped={ensureMapped}
          />
        </ChipsExcludeProvider>
      </div>

      {task && <OpenProjectComponent {...mappingDialogProps} />}
    </div>
  );
}
