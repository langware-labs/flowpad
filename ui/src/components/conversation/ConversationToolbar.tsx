import { useMemo } from 'react';
import type { ITask } from '@sdk/entities/task';
import { TaskChips } from './chips/TaskChips';
import { ConversationChips } from './chips/ConversationChips';
import { ChipsExcludeProvider } from './chips/ChipsExcludeContext';
import { taskChipKeys } from './chips/keys';

interface ConversationToolbarProps {
  task: ITask;
  conversationId: string;
  senderName?: string;
  /**
   * Optional override for the "Open Task" button. When omitted (default),
   * the chip navigates to `/dock/tasks/<taskId>/conversation/<convId>` —
   * the canonical anchor for this task + conversation pair.
   */
  onShowTask?: () => void;
  /** Wraps any action that needs a `cwd`/project. When unmapped, the parent will pop the mapping dialog and resume the action after the user picks. */
  ensureMapped?: (continuation: () => void | Promise<void>) => void;
}

/**
 * Sits next to the "Conversation" header. Composes the per-conversation
 * chip rows: ``TaskChips`` (project / spec / process button) followed by
 * ``ConversationChips`` (transcript / shared terminal). The latter is
 * wrapped in a ``ChipsExcludeProvider`` seeded with the keys ``TaskChips``
 * already rendered, so duplicates would be suppressed automatically.
 */
export function ConversationToolbar({
  task,
  conversationId,
  senderName,
  onShowTask,
  ensureMapped,
}: ConversationToolbarProps) {
  const taskKeys = useMemo(() => taskChipKeys(task), [task]);

  return (
    <div className="flex items-center gap-1">
      <TaskChips
        task={task}
        conversationId={conversationId}
        senderName={senderName}
        ensureMapped={ensureMapped}
        onShowTask={onShowTask}
      />
      <ChipsExcludeProvider add={taskKeys}>
        <ConversationChips conversationId={conversationId} task={task} />
      </ChipsExcludeProvider>
    </div>
  );
}
