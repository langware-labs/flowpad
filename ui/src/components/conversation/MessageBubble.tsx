import { useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import type { FlowMessage } from '@sdk';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { MessageActions } from './MessageActions';
import { PromptApprovalRow } from './PromptApprovalRow';
import { useLocalUser } from './useLocalUser';

interface MessageBubbleProps {
  message: ConversationMessage;
  flowMessageId?: string;
  flowMessage?: FlowMessage | null;
  task?: ITask;
  senderName: string;
  onEditName?: (newName: string) => void;
  onApproveAndExecute?: (attachmentIndex: number) => void;
  /** Optional content rendered below the message body (e.g. attachment chips). */
  footer?: ReactNode;
}

function avatarColor(role: ConversationMessage['role']): string {
  switch (role) {
    case 'sender':
      return 'bg-purple-500';
    case 'bot':
      return 'bg-slate-500';
    default:
      return 'bg-emerald-500';
  }
}

function formatTime(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function MessageBubble({
  message,
  flowMessageId,
  flowMessage,
  task,
  senderName,
  onEditName,
  onApproveAndExecute,
  footer,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const { localUser } = useLocalUser();

  const isFromOther = !!(flowMessage?.sender_id && localUser?.id && flowMessage.sender_id !== localUser.id);
  // Show the prompt row for ANY message that has a PROMPT attachment so the
  // sender sees the same preview the receiver does. Approve & Execute is
  // wired only when it's the other user's still-unapproved prompt — once
  // every PROMPT on the message is approved, the button disappears (each
  // approve flips approved_by; backend uses approve_all=true so all of a
  // message's prompts flip together).
  const promptAttachments = (flowMessage?.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.PROMPT,
  );
  const firstUnapprovedPromptIdx = (flowMessage?.attachment ?? []).findIndex(
    (a) => a.attachment_type === AttachmentType.PROMPT && !a.approved_by,
  );
  const hasUnapprovedPrompt = firstUnapprovedPromptIdx >= 0;
  const showPromptRow = promptAttachments.length > 0;
  const canApprovePrompt = isFromOther && hasUnapprovedPrompt && !!onApproveAndExecute;

  const startEdit = () => {
    setEditValue(senderName);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== senderName && onEditName) {
      onEditName(trimmed);
    }
  };

  const isBot = message.role === 'bot';
  const displayName = isBot ? 'Claude' : senderName || 'Unknown';
  const initial = (displayName.trim()[0] ?? '?').toUpperCase();
  const time = formatTime(message.timestamp);

  return (
    <div className="flex gap-2">
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColor(message.role)}`}
      >
        {initial}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline gap-2">
          {!isBot && editing ? (
            <input
              className="border-b border-input bg-transparent text-sm font-semibold text-foreground focus:outline-none"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setEditing(false);
              }}
              autoFocus
            />
          ) : (
            <span className="text-sm font-semibold text-foreground">{displayName}</span>
          )}
          {!isBot && onEditName && !editing && (
            <button
              onClick={startEdit}
              className="text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              title="Edit name"
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
          )}
          {time && <span className="text-[10px] text-muted-foreground">{time}</span>}
          <MessageActions flowMessageId={flowMessageId} />
        </div>
        {message.content && message.content !== '(proposed prompt)' && (
          <div className={`text-sm ${isBot ? 'italic text-foreground/70' : 'text-foreground/90'}`}>
            {message.content}
          </div>
        )}
        {showPromptRow && (
          <PromptApprovalRow
            attachments={promptAttachments}
            messageId={flowMessageId}
            onApprove={canApprovePrompt ? () => onApproveAndExecute!(firstUnapprovedPromptIdx) : undefined}
          />
        )}
        {footer}
      </div>
    </div>
  );
}
