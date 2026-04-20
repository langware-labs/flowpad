import { FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { downloadFlowMessageUrl, AttachmentType } from '@sdk/entities/flow-message';
import { MessageBubble } from './MessageBubble';
import { Download } from 'lucide-react';

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

  const hasDownloadableAttachments = (fm.attachment ?? []).some(
    (a) => a.attachment_type === AttachmentType.TYPE_ID || a.attachment_type === AttachmentType.FILE,
  );

  return (
    <div>
      <MessageBubble
        message={message}
        flowMessageId={messageId}
        senderName={fm.sender_name ?? ''}
      />
      {hasDownloadableAttachments && (
        <div className="mt-1 flex justify-end">
          <a
            href={downloadFlowMessageUrl(messageId)}
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
