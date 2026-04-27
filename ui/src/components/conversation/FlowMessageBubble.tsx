import { FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType, downloadFlowMessageUrl } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { Download } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { AttachmentChip } from './AttachmentChip';
import { useLocalUser } from './useLocalUser';

function localBundleUrl(messageId: string): string {
  return new ActionInfo('create-and-download-local-flowmsg', 'flow_message', messageId, 'GET').fullActionUrl;
}

function fileAttachmentUrl(messageId: string, vfsPath: string): string {
  const action = new ActionInfo('fs', 'flow_message', messageId, 'GET');
  action.subpath = `download/${vfsPath}`;
  return action.fullActionUrl;
}

interface FlowMessageBubbleProps {
  messageId: string;
  timestamp: string;
  task: ITask;
  onShowTask?: () => void;
  onExecute?: (messageId: string) => void;
  onApproveAndExecute?: (messageId: string, attachmentIndex: number) => void;
}

export function FlowMessageBubble({
  messageId,
  timestamp,
  task,
  onShowTask,
  onExecute,
  onApproveAndExecute,
}: FlowMessageBubbleProps) {
  const { data: fm } = useEntity<FlowMessage>(
    new TypeId(FlowMessage.type, messageId),
  );
  const { localUser, updateName } = useLocalUser();
  const [overrideName, setOverrideName] = useState<string | null>(null);

  if (!fm) return null;

  const isCurrentUser = !!(fm.sender_id && localUser?.id && fm.sender_id === localUser.id);
  const displayName = overrideName ?? (fm.sender_name || (isCurrentUser ? (localUser?.name || 'You') : 'Unknown'));

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

  const fileAttachments = (fm.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.FILE,
  );

  const hasAttachments = !!fm.attachment_filename || fileAttachments.length > 0;
  const totalAttachments = (fm.attachment_filename ? 1 : 0) + fileAttachments.length;

  const footer = hasAttachments ? (
    <div className="mt-2 space-y-1.5">
      {fm.attachment_filename && (
        <AttachmentChip
          url={downloadFlowMessageUrl(messageId, fm.attachment_filename)}
          filename={fm.attachment_filename}
        />
      )}
      {fileAttachments.map((a) => {
        const name = a.data.split('/').pop() ?? a.data;
        return (
          <AttachmentChip
            key={a.data}
            url={fileAttachmentUrl(messageId, a.data)}
            filename={name}
          />
        );
      })}
      {totalAttachments > 1 && (
        <a
          href={localBundleUrl(messageId)}
          download
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Download className="h-3 w-3" />
          Download all attachments
        </a>
      )}
    </div>
  ) : null;

  return (
    <MessageBubble
      message={message}
      flowMessageId={messageId}
      flowMessage={fm}
      task={task}
      senderName={displayName}
      onEditName={isCurrentUser ? async (newName) => {
        setOverrideName(newName);
        await updateName(newName);
      } : undefined}
      onShowTask={onShowTask}
      onExecute={onExecute ? () => onExecute(messageId) : undefined}
      onApproveAndExecute={onApproveAndExecute ? (idx) => onApproveAndExecute(messageId, idx) : undefined}
      footer={footer}
    />
  );
}
