import { dataContext, dataManager, FlowMessage, QueryRequest, TypeId, User } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useEffect, useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType, downloadFlowMessageUrl } from '@sdk/entities/flow-message';
import { ActionInfo } from '@sdk/models/ActionInfo';
import { MessageBubble } from './MessageBubble';
import { Download, Paperclip } from 'lucide-react';

function localBundleUrl(messageId: string): string {
  return new ActionInfo('create-and-download-local-flowmsg', 'flow_message', messageId, 'GET').fullActionUrl;
}

function fileAttachmentUrl(messageId: string, vfsPath: string): string {
  const action = new ActionInfo('fs', 'flow_message', messageId, 'GET');
  action.subpath = `download/${vfsPath}`;
  return action.fullActionUrl;
}

// Module-level cache so we only query once per session across all bubbles
let _localUserIdPromise: Promise<string | null> | null = null;
function getLocalUserId(): Promise<string | null> {
  if (_localUserIdPromise) return _localUserIdPromise;
  _localUserIdPromise = (async () => {
    // Fast path: context user is already the local user
    if (dataContext.user?.isLocal) return dataContext.user.id ?? null;
    // Slow path: context user is a cloud user — query to find the local one
    try {
      const users = await dataManager.query(new QueryRequest({ type: User.type }));
      return (users as User[]).find((u) => u.isLocal)?.id ?? null;
    } catch {
      return null;
    }
  })();
  return _localUserIdPromise;
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
  const [localUserId, setLocalUserId] = useState<string | null>(null);

  useEffect(() => {
    void getLocalUserId().then(setLocalUserId);
  }, []);

  if (!fm) return null;

  const isCurrentUser = !!(fm.sender_id && localUserId && fm.sender_id === localUserId);
  const displayName = isCurrentUser ? 'You' : (fm.sender_name || 'Unknown');

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

  return (
    <div>
      <MessageBubble
        message={message}
        flowMessageId={messageId}
        senderName={displayName}
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
      {fileAttachments.length > 0 && (
        <div className="mt-1.5 space-y-1 px-1">
          {fileAttachments.map((a) => {
            const name = a.data.split('/').pop() ?? a.data;
            return (
              <a
                key={a.data}
                href={fileAttachmentUrl(messageId, a.data)}
                download={name}
                className="flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1 text-[11px] text-foreground hover:bg-muted transition-colors max-w-[200px]"
                title={name}
              >
                <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
                <Download className="h-3 w-3 shrink-0 text-muted-foreground" />
              </a>
            );
          })}
          <a
            href={localBundleUrl(messageId)}
            download
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <Download className="h-3 w-3" />
            Download all attachments
          </a>
        </div>
      )}
    </div>
  );
}
