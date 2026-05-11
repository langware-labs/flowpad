import { useState, type MouseEvent, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import type { FlowMessage } from '@sdk';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { MessageChips } from './chips/MessageChips';
import { PromptApprovalRow } from './PromptApprovalRow';
import { useLocalUser } from './useLocalUser';
import { PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT } from './constants';

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
  /** Visual selection — drives the Context tab. */
  isSelected?: boolean;
  /** Click on the bubble fires this so the parent can mark it selected. */
  onSelect?: () => void;
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

/**
 * Approve & Execute drafts are wrapped as ``Prompt response: "<reply>"`` by the
 * useApproveAndExecute hook so the bubble can render the quoted middle in
 * ``<em>``. Once the user edits the draft and breaks the pattern, this returns
 * ``null`` and the message falls through to plain rendering — the italic styling
 * only applies until the user has made the message their own.
 */
const AGENT_QUOTE_PREFIX = 'Prompt response: "';
const AGENT_QUOTE_SUFFIX = '"';

function parseClaudeQuote(content: string): { prefix: string; quoted: string } | null {
  if (!content.startsWith(AGENT_QUOTE_PREFIX) || !content.endsWith(AGENT_QUOTE_SUFFIX)) return null;
  if (content.length <= AGENT_QUOTE_PREFIX.length + AGENT_QUOTE_SUFFIX.length) return null;
  const inner = content.slice(AGENT_QUOTE_PREFIX.length, -AGENT_QUOTE_SUFFIX.length);
  const unescaped = inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return { prefix: 'Prompt response:', quoted: unescaped };
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
  isSelected,
  onSelect,
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
    onSelect?.();
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

  const handleBubbleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    // Ignore clicks that originated on interactive children (buttons, links,
    // inputs) so name-edit / Approve & Execute / attachment downloads keep
    // their native behaviour without double-firing selection.
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, [role="menu"]')) return;
    onSelect();
  };

  return (
    <div
      className={`flex gap-2 rounded p-1 transition-colors ${
        onSelect ? 'cursor-pointer' : ''
      } ${isSelected ? 'ring-1 ring-ring/40 bg-muted/30' : ''}`}
      onClick={handleBubbleClick}
      data-testid={flowMessageId ? `message-bubble-${flowMessageId}` : undefined}
    >
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
          <MessageChips flowMessageId={flowMessageId} />
        </div>
        {message.content && message.content !== PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT && (() => {
          const claudeQuote = parseClaudeQuote(message.content);
          if (claudeQuote) {
            return (
              <div className={`text-sm ${isBot ? 'italic text-foreground/70' : 'text-foreground/90'}`}>
                <span className="font-medium text-muted-foreground">{claudeQuote.prefix}</span>{' '}
                <em className="italic text-foreground/85">&ldquo;{claudeQuote.quoted}&rdquo;</em>
              </div>
            );
          }
          return (
            <div className={`text-sm ${isBot ? 'italic text-foreground/70' : 'text-foreground/90'}`}>
              {message.content}
            </div>
          );
        })()}
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
