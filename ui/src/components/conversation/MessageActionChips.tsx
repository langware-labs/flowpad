import { FileText } from 'lucide-react';
import type { FlowMessage } from '@sdk';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { TypeId } from '@sdk/models';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';

interface MessageActionChipsProps {
  flowMessageId?: string;
  flowMessage?: FlowMessage | null;
  task?: ITask;
  /** Open the task spec side pane. Visible only when the message carries a TYPE_ID attachment that resolves to a task. */
  onShowTask?: () => void;
  /** Start a new Claude Code session, or open the existing one for this task. */
  onClaudeCode?: () => void;
  /** When true the chip reads "Start Claude Code session"; otherwise "Open Claude Code". */
  isStartLabel?: boolean;
}

const chipBase =
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors';

function messageHasTaskAttachment(fm: FlowMessage | null | undefined): boolean {
  for (const att of fm?.attachment ?? []) {
    if (att.attachment_type !== AttachmentType.TYPE_ID) continue;
    try {
      if (new TypeId(att.data).type === 'task') return true;
    } catch {
      // ignore malformed TypeId strings
    }
  }
  return false;
}

export function MessageActionChips({
  flowMessageId,
  flowMessage,
  task,
  onShowTask,
  onClaudeCode,
  isStartLabel,
}: MessageActionChipsProps) {
  if (!flowMessageId || !task) return null;

  const showTaskChip = !!onShowTask && messageHasTaskAttachment(flowMessage);
  const showClaudeChip = !!onClaudeCode;

  if (!showTaskChip && !showClaudeChip) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {showTaskChip && (
        <button
          type="button"
          onClick={onShowTask}
          className={`${chipBase} border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground`}
        >
          <FileText className="h-3 w-3" />
          Open task
        </button>
      )}

      {showClaudeChip && (
        <button
          type="button"
          onClick={onClaudeCode}
          className={`${chipBase} border-orange-500/40 bg-orange-500/10 text-orange-700 hover:bg-orange-500/20 dark:text-orange-300`}
        >
          <ClaudeIcon className="h-3 w-3" />
          {isStartLabel ? 'Start Claude Code session' : 'Open Claude Code'}
        </button>
      )}
    </div>
  );
}
