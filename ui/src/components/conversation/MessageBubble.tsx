import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Check, CheckCheck, Clock } from 'lucide-react';
import type { AgenticProcess, FlowMessage } from '@sdk';
import type { ConversationMessage } from '@sdk/entities/conversation';
import type { DeliveryStatus } from '@sdk/entities/flow-message';
import { Task, type ITask } from '@sdk/entities/task';
import { TaskItIcon, TaskOwnerChip, TaskStatusChip } from './task-it';
import { CHIP_LAYOUT, chipStyleFor } from './EntityChip';
import { MessageActionsMenu } from './MessageActionsMenu';
import { MARKDOWN_LINK_CLASS, MarkdownView } from '@src/components/markdown-view';
import { useLinks } from '@src/components/links/LinkMenu';
import { LinkifiedText } from '@src/components/links/LinkifiedText';
import { linkEventProps, type LinkHandlers } from '@src/components/links/link-events';
import type { Components } from 'react-markdown';
import { AttachmentActionsRow, PromptAttachmentPreview, useAttachmentActions } from './attachment-actions';
import { useLocalUser } from './useLocalUser';
import { avatarColorForMessage } from './avatar-color';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { useLingui } from '@lingui/react/macro';
import { QuotedMessage, ReactionChips } from './ChannelMessageExtras';
import type { IMessageReaction } from '@sdk/entities/flow-message';

interface MessageBubbleProps {
  message: ConversationMessage;
  flowMessageId?: string;
  flowMessage?: FlowMessage | null;
  /** The conversation's process: a link's right-click offers Vibe in it, as a terminal's does. */
  run?: AgenticProcess | null;
  task?: ITask;
  senderName: string;
  /** When set, the sender's name and avatar open the sender — an agent's profile. */
  onSenderClick?: () => void;
  onEditName?: (newName: string) => void;
  /** When set, renders a delete (trash) control on the bubble. The parent
   *  decides who may delete (sender or conversation owner) and only passes
   *  this for messages the local user is allowed to remove. Clicking it opens
   *  a destructive confirm dialog; on confirm this fires. */
  onDeleteMessage?: () => void;
  /** When set, renders a forward control on the bubble. Clicking it opens the
   *  parent's share dialog to pick the target conversation; the backend then
   *  clones the message (cloned_from_id provenance) into it. */
  onForwardMessage?: () => void;
  /** "Task it": make this message a task — or, once it is one (`task`), open it; an opened task
   *  also shows its status and owner. The parent decides which; the bubble only draws the chips. */
  taskIt?: { onClick: () => void; task?: Task | null };
  /** Spawn a Claude Code session pre-loaded with the receiver-context prompt
   *  (spec + transcript + conversation + attachments). Renders an emerald CTA
   *  chip styled like the primary attachment action when the bubble's message
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
  /** Whether the conversation already has a worker session — flips the Execute
   *  chip from "Run" to "<Host>'s session · new run". */
  /** Optional content rendered below the message body (e.g. attachment chips). */
  footer?: ReactNode;
  /** Visual selection — drives the Context tab. */
  isSelected?: boolean;
  /** Click on the bubble fires this so the parent can mark it selected. */
  onSelect?: () => void;
  /** The message this one quotes, drawn above the body; clicking it jumps there. */
  quoted?: { sender: string; text: string; onJump?: () => void } | null;
  /** Who reacted with what (a channel message). */
  reactions?: IMessageReaction[];
  /** When set, renders React — the channel shows reactions (`ChannelSpec.reacts`). */
  onReact?: (emoji: string, remove: boolean) => void;
  /** When set, renders Reply — the composer answers this message. */
  onReply?: () => void;
  /** The channel's replies only thread (`ChannelSpec.quotes` false): Reply says "Reply in thread". */
  replyInThread?: boolean;
}

/**
 * Three-state delivery receipt indicator (WhatsApp-style):
 *   created   → ✓        single check, muted
 *   delivered → ✓✓       double check, muted
 *   received  → ✓✓ blue  double check, accent color
 *
 * Renders nothing for incoming messages.
 */
function DeliveryReceipt({ status }: { status: DeliveryStatus | undefined }) {
  const { t } = useLingui();
  if (!status) return null;
  if (status === 'created') {
    // `created` = written to the local store, NOT yet accepted by the hub.
    // Show a clock ("Pending"), not a ✓ — a single check here would give false
    // confidence the recipient got it when the outbound hub push may have failed.
    return (
      <span title={t`Pending`} className="inline-flex items-center text-muted-foreground/70">
        <Clock className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === 'sent') {
    // `sent` = accepted/stored on the hub (one check). Not yet pulled by the recipient.
    return (
      <span title={t`Sent`} className="inline-flex items-center text-muted-foreground/70">
        <Check className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === 'delivered') {
    return (
      <span title={t`Delivered`} className="inline-flex items-center text-muted-foreground/70">
        <CheckCheck className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === 'received') {
    return (
      <span title={t`Read`} className="inline-flex items-center text-sky-500">
        <CheckCheck className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  }
  return null;
}

function formatTime(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Session replies are wrapped as ``Prompt response: "<reply>"`` by the
 * backend turn engine so the bubble can render the quoted middle in
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

/**
 * The message body text. `whitespace-pre-wrap` is the single source of truth for
 * preserving authored newlines — keeping it here (rather than on each call-site
 * div) stops the agent-quote and plain-text branches from drifting apart, which
 * is exactly how newlines got dropped from one branch before.
 */
function MessageBody({ content, isBot, links }: { content: string; isBot: boolean; links: LinkHandlers | null }) {
  const bodyClass = `whitespace-pre-wrap break-words text-sm ${isBot ? 'italic text-foreground/70' : 'text-foreground/90'}`;
  // Markdown links take the same click and menu as the plain-text ones.
  const components = useMemo<Partial<Components> | undefined>(() => links ? {
    a: ({ href, children }) => href
      ? <a href={href} className={MARKDOWN_LINK_CLASS} {...linkEventProps(links, href)}>{children}</a>
      : <>{children}</>,
  } : undefined, [links]);
  const claudeQuote = parseClaudeQuote(content);
  if (claudeQuote) {
    // The executed reply renders as real Markdown (bold, lists, code fences,
    // tables) via the canonical MarkdownView so it reads "pretty" — not a flat
    // italic quote. The muted "Prompt response:" label still flags it as an
    // unedited draft.
    return (
      <div className={`text-sm ${isBot ? 'text-foreground/70' : 'text-foreground/90'}`}>
        <span className="font-medium text-muted-foreground">{claudeQuote.prefix}</span>
        <div className="mt-1 break-words text-foreground/85">
          <MarkdownView value={claudeQuote.quoted} compact components={components} />
        </div>
      </div>
    );
  }
  // Without a message to resolve against, a link could only fail — keep it text.
  return <div className={bodyClass}>{links ? <LinkifiedText text={content} handlers={links} /> : content}</div>;
}

export function MessageBubble({
  message,
  flowMessageId,
  flowMessage,
  run,
  senderName,
  onSenderClick,
  onEditName,
  onDeleteMessage,
  onForwardMessage,
  taskIt,
  onImplementPlan,
  onOpenPlanSession,
  onViewPlan,
  footer,
  isSelected,
  onSelect,
  quoted,
  reactions,
  onReact,
  onReply,
  replyInThread,
}: MessageBubbleProps) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { localUser } = useLocalUser();
  // Links in the body resolve against this message, exactly as a terminal's resolve against its shell.
  const linkSource = useRef(flowMessage ?? null);
  linkSource.current = flowMessage ?? null;
  const links = useLinks(linkSource, run);

  const isFromOther = !!(flowMessage?.sender_id && localUser?.id && flowMessage.sender_id !== localUser.id);
  const isOutgoing = !!(flowMessage?.sender_id && localUser?.id && flowMessage.sender_id === localUser.id);
  const showReceipt = isOutgoing && !flowMessage?.is_draft;

  // Attachment-action pairs: every CTA (View/Implement Plan, …) comes from
  // the registry — the bubble only assembles the context. The prompt PREVIEW
  // renders for ANY message carrying a prompt attachment (sender sees what
  // the receiver sees); a prompt carries no CTA of its own — consent lives on
  // the session card under the opening message. `hasPlanSession === !!onOpenPlanSession` (set on
  // every spec-bearing bubble once one session is live in the thread).
  const { actions, promptAttachments, promptEntityTypeId } = useAttachmentActions({
    fm: flowMessage,
    messageId: flowMessageId,
    isFromOther,
    hasPlanSession: !!onOpenPlanSession,
    handlers: {
      implementPlan: onImplementPlan,
      openPlanSession: onOpenPlanSession,
      viewPlan: onViewPlan,
    },
  });
  const showPromptRow = promptAttachments.length > 0 || actions.length > 0;

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
  const displayName = isBot ? t`Claude` : senderName || t`Unknown`;
  const initial = (displayName.trim()[0] ?? '?').toUpperCase();
  const time = formatTime(message.timestamp);
  const ago = formatTimeAgo(message.timestamp);

  // The sender (avatar + name) is ONE element kind: a button when there is somewhere to open, else plain.
  const SenderTag = onSenderClick ? 'button' : 'span';
  const senderProps = onSenderClick ? { type: 'button' as const, onClick: onSenderClick } : {};

  const handleBubbleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    // Ignore clicks that originated on interactive children (buttons, links,
    // inputs) so name-edit / attachment actions / attachment downloads keep
    // their native behaviour without double-firing selection.
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, [role="menu"], [data-link]')) return;
    onSelect();
  };

  return (
    <div
      className={`group flex gap-2 rounded p-1 transition-colors ${
        onSelect ? 'cursor-pointer' : ''
      } ${isSelected ? 'bg-muted/30 ring-1 ring-ring/40' : ''}`}
      onClick={handleBubbleClick}
      data-testid={flowMessageId ? `message-bubble-${flowMessageId}` : undefined}
    >
      <SenderTag
        {...senderProps}
        aria-label={onSenderClick ? t`Open ${displayName}` : undefined}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColorForMessage(message.role, message.sender_id)}`}
      >
        {initial}
      </SenderTag>
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
            <SenderTag
              {...senderProps}
              className={`text-sm font-semibold text-foreground ${onSenderClick ? 'hover:underline' : ''}`}
              data-testid={onSenderClick ? 'message-sender-link' : undefined}
            >
              {displayName}
            </SenderTag>
          )}
          {time && (
            <span className="text-[10px] text-muted-foreground">
              {time}
              {ago && <span className="ms-1 opacity-70">· {ago}</span>}
            </span>
          )}
          {showReceipt && <DeliveryReceipt status={flowMessage?.delivery_status} />}
          {!editing && (
            <span className="self-center">
              <MessageActionsMenu
                flowMessageId={flowMessageId}
                conversationId={flowMessage?.conversation_id ?? undefined}
                messageText={message.content}
                origin={flowMessage?.origin}
                forwarded={!!flowMessage?.cloned_from_id}
                onReply={onReply}
                replyInThread={replyInThread}
                onReact={onReact ? (emoji) => onReact(emoji, false) : undefined}
                onForward={onForwardMessage}
                onTaskIt={taskIt && !taskIt.task ? taskIt.onClick : undefined}
                onEditName={!isBot && onEditName ? startEdit : undefined}
                onDelete={onDeleteMessage ? () => setConfirmingDelete(true) : undefined}
              />
            </span>
          )}
        </div>
        {quoted && <QuotedMessage sender={quoted.sender} text={quoted.text} onJump={quoted.onJump} />}
        {message.content && <MessageBody content={message.content} isBot={isBot} links={flowMessage ? links.handlers : null} />}
        {links.menu}
        {showPromptRow && (
          <AttachmentActionsRow
            actions={actions}
            preview={
              promptAttachments.length > 0 ? (
                <PromptAttachmentPreview
                  attachments={promptAttachments}
                  messageId={flowMessageId}
                  promptEntityTypeId={promptEntityTypeId}
                />
              ) : undefined
            }
          />
        )}
        {footer}
        {/* An opened task stays in view: its chip, then its state at a glance — each opens the task.
            Making one (Task it) lives in the ⋮ menu with the other actions. */}
        {taskIt?.task && !editing && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="message-task-chips">
            <button
              type="button"
              onClick={taskIt.onClick}
              className={`${CHIP_LAYOUT} ${chipStyleFor(Task.type)}`}
              title={t`Open task`}
              aria-label={t`Open task`}
              data-testid="message-task-it"
            >
              <TaskItIcon className="h-3 w-3 shrink-0" />
              <span className="max-w-[24rem] truncate">{taskIt.task.title || t`Task`}</span>
            </button>
            <TaskStatusChip status={taskIt.task.status} onClick={taskIt.onClick} />
            <TaskOwnerChip task={taskIt.task} onClick={taskIt.onClick} />
          </div>
        )}
        {reactions && reactions.length > 0 && <ReactionChips reactions={reactions} onToggle={onReact} />}
      </div>
      {onDeleteMessage && (
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={t`Delete this message?`}
          description={t`This permanently deletes the message and all of its data for everyone in the conversation. This can't be undone.`}
          confirmLabel={t`Delete`}
          variant="destructive"
          onConfirm={onDeleteMessage}
        />
      )}
    </div>
  );
}
