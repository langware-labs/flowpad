import { FlowMessage, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useState } from 'react';
import type { ITask } from '@sdk/entities/task';
import type { ConversationMessage } from '@sdk/entities/conversation';
import { AttachmentType, downloadFlowMessageUrl } from '@sdk/entities/flow-message';
import { Download, Pencil, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { MessageBubble } from './MessageBubble';
import { AttachmentChip } from './AttachmentChip';
import { fileAttachmentUrl } from './attachment-url';
import { useLocalUser } from './useLocalUser';
import { discardDraftFlowMessage, localBundleUrl, sendDraftFlowMessage } from './flow-message-drafts';


interface FlowMessageBubbleProps {
  messageId: string;
  timestamp: string;
  task?: ITask | null;
  onApproveAndExecute?: (messageId: string, attachmentIndex: number) => void;
  /** Render the bubble as a local draft (dashed border + Edit/Send/Discard). */
  isDraft?: boolean;
  /** Called after a successful send-draft so the parent can refetch. */
  onDraftSent?: () => void;
}

export function FlowMessageBubble({
  messageId,
  timestamp,
  task,
  onApproveAndExecute,
  isDraft,
  onDraftSent,
}: FlowMessageBubbleProps) {
  const { data: fm } = useEntity<FlowMessage>(
    new TypeId(FlowMessage.type, messageId),
  );
  const { localUser, updateName } = useLocalUser();
  const [overrideName, setOverrideName] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState(false);
  const [draftEditValue, setDraftEditValue] = useState<string>('');
  const [busyDraft, setBusyDraft] = useState<'send' | 'discard' | null>(null);

  if (!fm) {
    // The pointer to this FlowMessage is in the conversation.jsonl, but the
    // entity itself hasn't been materialised locally yet (it lands via the
    // hub bundle, which is fetched asynchronously). Show a thin placeholder
    // instead of returning null so the bubble doesn't disappear silently.
    return (
      <div className="flex gap-2 opacity-60">
        <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
          <span className="text-[11px] italic text-muted-foreground/70">Loading message…</span>
        </div>
      </div>
    );
  }

  const isCurrentUser = !!(fm.sender_id && localUser?.id && fm.sender_id === localUser.id);
  const displayName = overrideName ?? (fm.sender_name || (isCurrentUser ? (localUser?.name || 'You') : 'Unknown'));

  // When task is present, role tracks the original task initiator (sender) vs
  // recipient. For project-scoped conversations (no task), use the local user
  // as the "sender" perspective.
  const role: 'sender' | 'recipient' = task
    ? fm.sender_id && task.shared_by_id && fm.sender_id === task.shared_by_id
      ? 'sender'
      : 'recipient'
    : isCurrentUser
    ? 'sender'
    : 'recipient';

  const message: ConversationMessage = {
    role,
    content: fm.text ?? '',
    sender_id: fm.sender_id ?? '',
    timestamp,
  };

  // Filter out the conversation.jsonl transcript — that lives on the toolbar now.
  const fileAttachments = (fm.attachment ?? []).filter(
    (a) => a.attachment_type === AttachmentType.FILE && !a.data.endsWith('conversation.jsonl'),
  );

  const hasAttachments = !!fm.attachment_filename || fileAttachments.length > 0;
  const totalAttachments = (fm.attachment_filename ? 1 : 0) + fileAttachments.length;

  const handleSendDraft = async () => {
    if (!fm?.id || busyDraft) return;
    setBusyDraft('send');
    try {
      await sendDraftFlowMessage(fm, editingDraft ? draftEditValue : undefined);
      setEditingDraft(false);
      onDraftSent?.();
    } catch (err) {
      console.error('[FlowMessageBubble] send-draft failed', err);
      toast.error('Failed to send draft');
    } finally {
      setBusyDraft(null);
    }
  };

  const handleDiscardDraft = async () => {
    if (!fm || busyDraft) return;
    if (!window.confirm('Discard this draft reply?')) return;
    setBusyDraft('discard');
    try {
      await discardDraftFlowMessage(fm);
      onDraftSent?.();
    } catch (err) {
      console.error('[FlowMessageBubble] discard draft failed', err);
      toast.error('Failed to discard draft');
    } finally {
      setBusyDraft(null);
    }
  };

  const startEditDraft = () => {
    setDraftEditValue(fm.text ?? '');
    setEditingDraft(true);
  };

  const draftFooter = isDraft ? (
    <div className="mt-2 space-y-2 rounded-md border border-dashed border-border bg-muted/20 p-2">
      {editingDraft ? (
        <textarea
          className="w-full resize-y rounded border border-input bg-background p-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          value={draftEditValue}
          onChange={(e) => setDraftEditValue(e.target.value)}
          rows={Math.max(3, Math.min(12, draftEditValue.split('\n').length + 1))}
          autoFocus
        />
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Draft</span>
        <div className="ml-auto flex items-center gap-1.5">
          {!editingDraft && (
            <button
              type="button"
              onClick={startEditDraft}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Edit draft"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSendDraft()}
            disabled={busyDraft !== null}
            className="inline-flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            title="Send draft"
          >
            <Send className="h-3 w-3" />
            {busyDraft === 'send' ? 'Sending…' : 'Send'}
          </button>
          <button
            type="button"
            onClick={() => void handleDiscardDraft()}
            disabled={busyDraft !== null}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            title="Discard draft"
          >
            <Trash2 className="h-3 w-3" />
            Discard
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const footer = (
    <>
      {hasAttachments && (
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
      )}
      {draftFooter}
    </>
  );

  // While the user is editing a draft, swap the body text with their in-progress
  // edit so the bubble reflects what the recipient will see on send.
  const renderedMessage: ConversationMessage = isDraft && editingDraft
    ? { ...message, content: draftEditValue }
    : message;

  return (
    <MessageBubble
      message={renderedMessage}
      flowMessageId={messageId}
      flowMessage={fm}
      task={task ?? undefined}
      senderName={displayName}
      onEditName={isCurrentUser ? async (newName) => {
        setOverrideName(newName);
        await updateName(newName);
      } : undefined}
      onApproveAndExecute={onApproveAndExecute ? (idx) => onApproveAndExecute(messageId, idx) : undefined}
      footer={footer}
    />
  );
}
