import { useState, type MouseEvent, type ReactNode } from 'react';
import { Pencil, Check, CheckCheck, Clock, Trash2 } from 'lucide-react';
import type { FlowMessage } from '@sdk';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType, type DeliveryStatus } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { MessageChips } from './chips/MessageChips';
import { PromptApprovalRow } from './PromptApprovalRow';
import { useLocalUser } from './useLocalUser';
import { PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT } from './constants';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { flowMessageSpecTypeId } from './flow-message-helpers';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';

interface MessageBubbleProps {
  message: ConversationMessage;
  flowMessageId?: string;
  flowMessage?: FlowMessage | null;
  task?: ITask;
  senderName: string;
  onEditName?: (newName: string) => void;
  /** When set, renders a delete (trash) control on the bubble. The parent
   *  decides who may delete (sender or conversation owner) and only passes
   *  this for messages the local user is allowed to remove. Clicking it opens
   *  a destructive confirm dialog; on confirm this fires. */
  onDeleteMessage?: () => void;
  onApproveAndExecute?: (attachmentIndex: number) => void;
  /** Spawn a Claude Code session pre-loaded with the receiver-context prompt
   *  (spec + transcript + conversation + attachments). Renders an emerald CTA
   *  chip styled identically to Approve & Execute when the bubble's message
   *  carries a Spec TypeId and the local user is the recipient. */
  onImplementPlan?: () => void;
  /** When a plan-implementation session already exists for this conversation,
   *  the bubble shows an "Open Plan Implementation Session" link in place of
   *  the Implement Plan chip. Set on every spec-bearing bubble in the thread
   *  once one session is live so all bubbles point at the same session. */
  onOpenPlanSession?: () => void;
  /** Open the spec's markdown in an editable Milkdown view. Fires with the
   *  Spec id the bubble carries — the bubble itself does the lookup so the
   *  parent doesn't have to thread per-message TypeIds. Independent of the
   *  Implement Plan / Open Session state — View Plan always renders when the
   *  bubble has a spec and the local user is the recipient. */
  onViewPlan?: (specId: string) => void;
  /** Optional content rendered below the message body (e.g. attachment chips). */
  footer?: ReactNode;
  /** Visual selection — drives the Context tab. */
  isSelected?: boolean;
  /** Click on the bubble fires this so the parent can mark it selected. */
  onSelect?: () => void;
  /**
   * Parent conversation's `message_status_visible` flag. When false, the
   * receipt indicator is hidden on the sender side regardless of the
   * underlying ``delivery_status``. Defaults to true.
   */
  conversationStatusVisible?: boolean;
}

/**
 * Three-state delivery receipt indicator (WhatsApp-style):
 *   created   → ✓        single check, muted
 *   delivered → ✓✓       double check, muted
 *   received  → ✓✓ blue  double check, accent color
 *
 * Renders nothing for incoming messages or when the parent conversation's
 * `message_status_visible` flag is false.
 */
function DeliveryReceipt({ status }: { status: DeliveryStatus | undefined }) {
  if (!status) return null;
  if (status === 'created') {
    // `created` = written to the local store, NOT yet accepted by the hub.
    // Show a clock ("Pending"), not a ✓ — a single check here would give false
    // confidence the recipient got it when the outbound hub push may have failed.
    return (
      <span title="Pending" className="inline-flex items-center text-muted-foreground/70">
        <Clock className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === 'sent') {
    // `sent` = accepted/stored on the hub (one check). Not yet pulled by the recipient.
    return (
      <span title="Sent" className="inline-flex items-center text-muted-foreground/70">
        <Check className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === 'delivered') {
    return (
      <span title="Delivered" className="inline-flex items-center text-muted-foreground/70">
        <CheckCheck className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === 'received') {
    return (
      <span title="Read" className="inline-flex items-center text-sky-500">
        <CheckCheck className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  return null;
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
  onDeleteMessage,
  onApproveAndExecute,
  onImplementPlan,
  onOpenPlanSession,
  onViewPlan,
  footer,
  isSelected,
  onSelect,
  conversationStatusVisible = true,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { localUser } = useLocalUser();

  const isFromOther = !!(flowMessage?.sender_id && localUser?.id && flowMessage.sender_id !== localUser.id);
  const isOutgoing = !!(flowMessage?.sender_id && localUser?.id && flowMessage.sender_id === localUser.id);
  const showReceipt = isOutgoing && conversationStatusVisible && !flowMessage?.is_draft;
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
  const canApprovePrompt = isFromOther && hasUnapprovedPrompt && !!onApproveAndExecute;

  // Implement Plan / Open Plan Implementation Session: same gating shape as
  // Approve & Execute — only spec-bearing bubbles from the other user (so the
  // local user is the recipient) qualify. When `onOpenPlanSession` is set
  // (a session already exists somewhere in the thread) the row swaps the
  // emerald chip for an open-link affordance pointing at that session. Both
  // states share `PromptApprovalRow`'s container so they land in the same
  // horizontal slot (alongside Approve when both fire).
  const specTypeId = flowMessageSpecTypeId(flowMessage);
  const isSpecBearingRecipient = isFromOther && !!specTypeId;
  const canImplementPlan = isSpecBearingRecipient && !!onImplementPlan && !onOpenPlanSession;
  const canOpenPlanSession = isSpecBearingRecipient && !!onOpenPlanSession;
  // View Plan is purely a reader affordance — independent of session state,
  // so it stays visible even after Implement Plan flips to Open.
  const canViewPlan = isSpecBearingRecipient && !!onViewPlan;
  const showPromptRow = promptAttachments.length > 0 || canImplementPlan || canOpenPlanSession || canViewPlan;

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
  const ago = formatTimeAgo(message.timestamp);

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
          {onDeleteMessage && !editing && (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="text-muted-foreground/50 transition-colors hover:text-destructive"
              title="Delete message"
              aria-label="Delete message"
            >
              <Trash2 className="h-2.5 w-2.5" />
            </button>
          )}
          {time && (
            <span className="text-[10px] text-muted-foreground">
              {time}
              {ago && <span className="ml-1 opacity-70">· {ago}</span>}
            </span>
          )}
          {showReceipt && <DeliveryReceipt status={flowMessage?.delivery_status} />}
          <MessageChips
            flowMessageId={flowMessageId}
            conversationId={flowMessage?.conversation_id ?? undefined}
            messageText={message.content}
          />
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
            onApprove={canApprovePrompt ? () => onApproveAndExecute(firstUnapprovedPromptIdx) : undefined}
            onImplementPlan={canImplementPlan ? onImplementPlan : undefined}
            onOpenPlanSession={canOpenPlanSession ? onOpenPlanSession : undefined}
            onViewPlan={canViewPlan && specTypeId && onViewPlan ? () => onViewPlan(specTypeId.id) : undefined}
          />
        )}
        {footer}
      </div>
      {onDeleteMessage && (
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title="Delete this message?"
          description="This permanently deletes the message and all of its data for everyone in the conversation. This can't be undone."
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={onDeleteMessage}
        />
      )}
    </div>
  );
}
