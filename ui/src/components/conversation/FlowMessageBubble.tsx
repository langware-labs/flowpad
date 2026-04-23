import { FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType, downloadFlowMessageUrl } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { MessageBubble } from './MessageBubble';
import { Download, Paperclip } from 'lucide-react';

function localBundleUrl(messageId: string): string {
  return new ActionInfo('create-and-download-local-flowmsg', 'flow_message', messageId, 'GET').fullActionUrl;
}

interface FlowMessageBubbleProps {
  messageId: string;
  timestamp: string;
  task: ITask;
}

export function FlowMessageBubble({ messageId, timestamp, task }: FlowMessageBubbleProps) {
  const { data: fm } = useEntity<FlowMessage>(
    new TypeId(FlowMessage.type, messageId),
  );

  if (!fm) return null;

  const role =
    fm.sender_id && task.shared_by_id && fm.sender_id === task.shared_by_id
      ? 'sender'
      : 'recipient';

  const message: ConversationMessage = {
    role,
    content: fm.text ?? '',
    sender_id: fm.sender_id ?? '',
    timestamp,
  };

  const hasFileAttachments = (fm.attachment ?? []).some(
    (a) => a.attachment_type === AttachmentType.FILE,
  );

  return (
    <div>
      <MessageBubble
        message={message}
        flowMessageId={messageId}
        senderName={fm.sender_name ?? ''}
      />
      {fm.attachment_filename && (
        <div className="mt-1.5 px-1">
          <a
            href={downloadFlowMessageUrl(messageId, fm.attachment_filename)}
            download
            className="flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1 text-[11px] text-foreground hover:bg-muted transition-colors max-w-[200px]"
            title={fm.attachment_filename}
          >
            <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{fm.attachment_filename}</span>
            <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
          </a>
        </div>
      )}
      {hasFileAttachments && (
        <div className="mt-1 flex justify-end">
          <a
            href={localBundleUrl(messageId)}
            download
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <Download className="h-3 w-3" />
            Download attachments
          </a>
        </div>
      )}
    </div>
  );
}
