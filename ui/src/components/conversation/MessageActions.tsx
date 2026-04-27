import { useState } from 'react';
import { Download, FileText, MessageSquarePlus, Sparkles } from 'lucide-react';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { dataManager, FlowMessage, TypeId } from '@sdk';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { useLocalUser } from './useLocalUser';
import { PromptComposerDialog } from './PromptComposerDialog';

interface MessageActionsProps {
  flowMessageId?: string;
  flowMessage?: FlowMessage | null;
  task?: ITask;
  onShowTask?: () => void;
  onExecute?: () => void;
  onApproveAndExecute?: (attachmentIndex: number) => void;
}

function localDownloadUrl(messageId: string): string {
  return new ActionInfo('create-and-download-local-flowmsg', 'flow_message', messageId, 'GET').fullActionUrl;
}

export function MessageActions({
  flowMessageId,
  flowMessage,
  task,
  onShowTask,
  onExecute,
  onApproveAndExecute,
}: MessageActionsProps) {
  const { localUser } = useLocalUser();
  const [showPrompt, setShowPrompt] = useState(false);

  if (!flowMessageId) return null;

  const isFromOther = !!(flowMessage?.sender_id && localUser?.id && flowMessage.sender_id !== localUser.id);
  const promptIdx = (flowMessage?.attachment ?? []).findIndex(
    (a) => a.attachment_type === AttachmentType.PROMPT && !a.approved_by,
  );
  const showApprove = isFromOther && promptIdx >= 0 && !!onApproveAndExecute;

  return (
    <div className="ml-1 flex items-center gap-0.5">
      <a
        href={localDownloadUrl(flowMessageId)}
        download
        title="Download message"
        className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
      >
        <Download className="h-3 w-3" />
      </a>

      {onShowTask && task?.spec_id && (
        <button
          type="button"
          onClick={onShowTask}
          title="Show task spec"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
        >
          <FileText className="h-3 w-3" />
        </button>
      )}

      {task && (
        <button
          type="button"
          onClick={() => setShowPrompt(true)}
          title="Propose a prompt"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
        >
          <MessageSquarePlus className="h-3 w-3" />
        </button>
      )}

      {showApprove && (
        <button
          type="button"
          onClick={() => onApproveAndExecute!(promptIdx)}
          title="Approve and execute prompt"
          className="flex h-5 w-5 items-center justify-center rounded text-emerald-600 opacity-80 transition-opacity hover:opacity-100"
        >
          <Sparkles className="h-3 w-3" />
        </button>
      )}

      {onExecute && (
        <button
          type="button"
          onClick={onExecute}
          title="Execute with Claude Code"
          className="flex h-5 w-5 items-center justify-center rounded text-orange-500 opacity-80 transition-opacity hover:opacity-100"
        >
          <ClaudeIcon className="h-3 w-3" />
        </button>
      )}

      {task && (
        <PromptComposerDialog
          open={showPrompt}
          onClose={() => setShowPrompt(false)}
          task={task}
          onSent={async () => {
            // Refresh the FlowMessage entity so the new prompt shows up immediately
            if (flowMessageId) {
              await dataManager.getByTypeId<FlowMessage>(new TypeId(FlowMessage.type, flowMessageId)).catch(() => null);
            }
          }}
        />
      )}
    </div>
  );
}
