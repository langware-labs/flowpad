import { useState } from 'react';
import { FileText, MessageSquarePlus, Sparkles } from 'lucide-react';
import { dataManager, FlowMessage, TypeId } from '@sdk';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { useLocalUser } from './useLocalUser';
import { PromptComposerDialog } from './PromptComposerDialog';

interface MessageActionChipsProps {
  flowMessageId?: string;
  flowMessage?: FlowMessage | null;
  task?: ITask;
  onShowTask?: () => void;
  onExecute?: () => void;
  onApproveAndExecute?: (attachmentIndex: number) => void;
}

const chipBase =
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors';

export function MessageActionChips({
  flowMessageId,
  flowMessage,
  task,
  onShowTask,
  onExecute,
  onApproveAndExecute,
}: MessageActionChipsProps) {
  const { localUser } = useLocalUser();
  const [showPrompt, setShowPrompt] = useState(false);

  if (!flowMessageId || !task) return null;

  const isFromOther = !!(flowMessage?.sender_id && localUser?.id && flowMessage.sender_id !== localUser.id);
  const promptIdx = (flowMessage?.attachment ?? []).findIndex(
    (a) => a.attachment_type === AttachmentType.PROMPT && !a.approved_by,
  );
  const showApprove = isFromOther && promptIdx >= 0 && !!onApproveAndExecute;

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

      <button
        type="button"
        onClick={() => setShowPrompt(true)}
        className={`${chipBase} border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground`}
      >
        <MessageSquarePlus className="h-3 w-3" />
        Add prompt
      </button>

      {showApprove && (
        <button
          type="button"
          onClick={() => onApproveAndExecute!(promptIdx)}
          className={`${chipBase} border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300`}
        >
          <Sparkles className="h-3 w-3" />
          Approve &amp; Execute
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

      <PromptComposerDialog
        open={showPrompt}
        onClose={() => setShowPrompt(false)}
        task={task}
        onSent={async () => {
          if (flowMessageId) {
            await dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, flowMessageId)).catch(() => null);
          }
        }}
      />
    </div>
  );
}
