import { FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType, downloadFlowMessageUrl } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { MessageBubble } from './MessageBubble';
import { useLocalUser } from './useLocalUser';
import { Download, Paperclip } from 'lucide-react';

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
}

export function FlowMessageBubble({ messageId, timestamp, task }: FlowMessageBubbleProps) {
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

  const footer = hasAttachments ? (
    <div className="mt-1.5 space-y-1">
      {fm.attachment_filename && (
        <a
          href={downloadFlowMessageUrl(messageId, fm.attachment_filename)}
          download
          className="flex max-w-[240px] items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
          title={fm.attachment_filename}
        >
          <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{fm.attachment_filename}</span>
          <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
        </a>
      )}
      {fileAttachments.map((a) => {
        const name = a.data.split('/').pop() ?? a.data;
        return (
          <a
            key={a.data}
            href={fileAttachmentUrl(messageId, a.data)}
            download={name}
            className="flex max-w-[240px] items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
            title={name}
          >
            <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
            <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
      {fileAttachments.length > 0 && (
        <a
          href={localBundleUrl(messageId)}
          download
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
      senderName={displayName}
      onEditName={isCurrentUser ? async (newName) => {
        setOverrideName(newName);
        await updateName(newName);
      } : undefined}
      footer={footer}
    />
  );
}
