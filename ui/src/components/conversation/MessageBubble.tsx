import { useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import {
  AgenticProcess,
  dataManager,
  type FlowMessage,
  TypeId,
} from '@sdk';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
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
  const { navigation } = useDockNavigation();

  const isFromOther = !!(flowMessage?.sender_id && localUser?.id && flowMessage.sender_id !== localUser.id);
  // Show the prompt row for ANY message that has a PROMPT attachment so the
  // sender sees the same preview the receiver does. The Approve & Execute
  // button is only wired when it's the other user's still-unapproved prompt.
  const promptIdx = (flowMessage?.attachment ?? []).findIndex(
    (a) => a.attachment_type === AttachmentType.PROMPT,
  );
  const promptAttachment = promptIdx >= 0 ? flowMessage?.attachment?.[promptIdx] : undefined;
  const showPromptRow = !!promptAttachment;
  const canApprovePrompt =
    isFromOther && !!promptAttachment && !promptAttachment.approved_by && !!onApproveAndExecute;

  const sharedProcessId = (task?.metadata as Record<string, unknown> | undefined)?.shared_process_id as
    | string
    | undefined;
  const canOpenShared = !!promptAttachment && !!promptAttachment.approved_by && !!sharedProcessId;

  const handleOpenShared = async () => {
    if (!sharedProcessId) return;
    const proc = await dataManager
      .getByTypeId<AgenticProcess>(new TypeId(AgenticProcess.type, sharedProcessId))
      .catch(() => null);
    if (!proc) return;
    // Open in the SAME browser tab — replaces the conversation view with the
    // shared terminal. The user wants this in-place, not in a secondary window.
    navigation.openDock(proc.dockPointer);
  };

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
        {showPromptRow && promptAttachment && (
          <PromptApprovalRow
            attachment={promptAttachment}
            onApprove={canApprovePrompt ? () => onApproveAndExecute!(promptIdx) : undefined}
            onOpenShared={canOpenShared ? () => void handleOpenShared() : undefined}
          />
        )}
        {footer}
      </div>
    </div>
  );
}
