import { FileText } from 'lucide-react';
import type { ITask } from '@sdk/entities/task';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';

interface MessageActionChipsProps {
  flowMessageId?: string;
  task?: ITask;
  onShowTask?: () => void;
  onExecute?: () => void;
}

const chipBase =
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors';

export function MessageActionChips({
  flowMessageId,
  task,
  onShowTask,
  onExecute,
}: MessageActionChipsProps) {
  if (!flowMessageId || !task) return null;

  if (!onShowTask && !onExecute) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {onShowTask && task.spec_id && (
        <button
          type="button"
          onClick={onShowTask}
          className={`${chipBase} border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground`}
        >
          <FileText className="h-3 w-3" />
          Show task
        </button>
      )}

      {onExecute && (
        <button
          type="button"
          onClick={onExecute}
          className={`${chipBase} border-orange-500/40 bg-orange-500/10 text-orange-700 hover:bg-orange-500/20 dark:text-orange-300`}
        >
          <ClaudeIcon className="h-3 w-3" />
          Execute with Claude Code
        </button>
      )}
    </div>
  );
}
