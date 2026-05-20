import { useEffect, useMemo, useRef, useState } from 'react';
import { File as FileIcon, MessageSquarePlus, Paperclip, Send, Trash2, X } from 'lucide-react';
import type { FlowMessage } from '@sdk';
import { sendReply } from '@sdk/entities/notifications';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { toast } from 'sonner';
import { cn } from '@src/lib/utils';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_LABEL } from './constants';
import { PromptComposerDialog, type QueuedPrompt } from './PromptComposerDialog';
import { PromptApprovalRow } from './PromptApprovalRow';
import { useLocalUser } from './useLocalUser';
import { discardDraftFlowMessage } from './flow-message-drafts';

interface DraftMessageComposerProps {
  fm: FlowMessage;
  conversationId?: string;
  /** Fires after successful send (draft promoted to real reply). */
  onAfterSend?: () => void;
  /** Fires after successful discard. */
  onAfterDiscard?: () => void;
}

const SAVE_DEBOUNCE_MS = 400;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DraftMessageComposer({
  fm,
  conversationId,
  onAfterSend,
  onAfterDiscard,
}: DraftMessageComposerProps) {
  const initialText = fm.text ?? '';
  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<File[]>([]);
  const [queuedPrompt, setQueuedPrompt] = useState<QueuedPrompt | null>(null);
  const [showPromptDialog, setShowPromptDialog] = useState(false);
  const [sending, setSending] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { localUser } = useLocalUser();
  const ensureCloudLogin = useCloudLoginGate();

  // Anyone in a conversation can suggest a prompt — initiator-vs-recipient
  // gating proved confusing and the initiator often wants to queue a prompt
  // for their own next headless run too. Match MessageComposer.tsx, which
  // only requires that we have a destination conversation.
  const canAddPrompt = !!conversationId;
  const isBusy = sending || discarding;

  // Debounced auto-save: persists edits into the FlowMessage entity so a
  // page reload doesn't lose them. Without this the only persistence point
  // would be Send, which defeats the "edit-and-save-as-you-go" UX.
  const lastSavedRef = useRef(initialText);
  useEffect(() => {
    if (text === lastSavedRef.current) return;
    const handle = setTimeout(() => {
      if (text === lastSavedRef.current) return;
      fm.text = text;
      lastSavedRef.current = text;
      void fm.save().catch((err) => {
        console.error('[DraftMessageComposer] auto-save failed', err);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [text, fm]);

  const queuedPromptAttachments: Attachment[] = useMemo(() => {
    if (!queuedPrompt) return [];
    const list: Attachment[] = [];
    if (queuedPrompt.text) {
      list.push({ attachment_type: AttachmentType.PROMPT, data: queuedPrompt.text });
    }
    for (const f of queuedPrompt.files) {
      list.push({ attachment_type: AttachmentType.PROMPT, data: `prompt/${f.name}` });
    }
    return list;
  }, [queuedPrompt]);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const tooBig: string[] = [];
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(incoming)) {
        if (f.size > MAX_FILE_SIZE_BYTES) {
          tooBig.push(f.name);
          continue;
        }
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      return next;
    });
    // Fresh pick replaces the previous size-rejection notice; if the new
    // selection has no over-limit files the warning clears.
    setError(
      tooBig.length === 0
        ? null
        : tooBig.length === 1
          ? `"${tooBig[0]}" is over ${MAX_FILE_SIZE_LABEL} and was not attached.`
          : `${tooBig.length} files over ${MAX_FILE_SIZE_LABEL} were not attached: ${tooBig.join(', ')}.`,
    );
  };

  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  const sendWith = async (effectivePrompt: QueuedPrompt | null) => {
    if (isBusy) return;
    const trimmed = text.trim();
    if (!trimmed && !effectivePrompt && files.length === 0) return;
    setSending(true);
    setError(null);
    try {
      // Cloud reply needs an authenticated hub token; otherwise the hub POST
      // returns 401 and the send fails silently. Route through OAuth first,
      // then resume the send on the same click.
      const gate = await ensureCloudLogin();
      if (!gate.ok) {
        setError(gate.error);
        toast.error(gate.error);
        return;
      }
      // Promotion path: discard the local-only draft and send through the
      // regular reply pipeline so files + prompt-attachments use exactly the
      // same code path as a fresh composer send. Single code path beats
      // duplicating the upload/push plumbing for drafts.
      await discardDraftFlowMessage(fm);
      const extras = effectivePrompt
        ? {
            promptText: effectivePrompt.text || undefined,
            promptFiles: effectivePrompt.files.length > 0 ? effectivePrompt.files : undefined,
          }
        : undefined;
      await sendReply(
        { conversationId },
        trimmed,
        files.length > 0 ? files : undefined,
        extras,
      );
      onAfterSend?.();
    } catch (err: unknown) {
      console.error('[DraftMessageComposer] send failed', err);
      setError(err instanceof Error ? err.message : 'Failed to send draft.');
      toast.error('Failed to send draft');
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => void sendWith(queuedPrompt);

  const handleDiscard = async () => {
    if (isBusy) return;
    if (!window.confirm('Discard this draft?')) return;
    setDiscarding(true);
    try {
      await discardDraftFlowMessage(fm);
      onAfterDiscard?.();
    } catch (err: unknown) {
      console.error('[DraftMessageComposer] discard failed', err);
      toast.error('Failed to discard draft');
    } finally {
      setDiscarding(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isBusy) setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!isBusy) addFiles(e.dataTransfer.files);
  };

  const canSend = (!!text.trim() || !!queuedPrompt || files.length > 0) && !isBusy;
  const senderName = fm.sender_name?.trim() || (localUser?.name ?? 'You');
  const initial = (senderName.trim()[0] ?? '?').toUpperCase();

  return (
    <div className="flex gap-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-xs font-semibold text-white">
        {initial}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border border-dashed border-border bg-muted/20 p-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{senderName}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Draft
          </span>
        </div>

        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            'flex flex-col gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 transition-colors focus-within:border-primary/50',
            dragging && 'border-primary bg-primary/5',
          )}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={dragging ? 'Drop files here' : 'Edit your draft…'}
            rows={Math.max(2, Math.min(10, text.split('\n').length + 1))}
            disabled={isBusy}
            className="w-full min-h-[2.5rem] resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
              title="Attach files"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              disabled={isBusy}
              onChange={(e) => addFiles(e.target.files)}
              onClick={(e) => ((e.target as HTMLInputElement).value = '')}
            />
            {canAddPrompt && (
              <button
                type="button"
                onClick={() => setShowPromptDialog(true)}
                disabled={isBusy}
                title={queuedPrompt ? 'Edit attached prompt' : 'Suggest a prompt for the other user to approve'}
                className={cn(
                  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-40',
                  queuedPrompt
                    ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300'
                    : 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300',
                )}
              >
                <MessageSquarePlus className="h-3 w-3" />
                {queuedPrompt ? 'Edit prompt' : 'Suggest prompt'}
              </button>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleDiscard()}
                disabled={isBusy}
                title="Discard draft"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                title="Send"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {canAddPrompt && queuedPrompt && (
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <PromptApprovalRow attachments={queuedPromptAttachments} onEdit={() => setShowPromptDialog(true)} />
            </div>
            <button
              type="button"
              onClick={() => setQueuedPrompt(null)}
              title="Remove queued prompt"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center gap-2 rounded border border-input bg-muted/40 px-2 py-1 text-xs"
              >
                <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-foreground" title={f.name}>{f.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatSize(f.size)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  disabled={isBusy}
                  className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive disabled:pointer-events-none"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {canAddPrompt && (
          <PromptComposerDialog
            open={showPromptDialog}
            onClose={() => setShowPromptDialog(false)}
            initial={queuedPrompt}
            onQueue={(p) => setQueuedPrompt(p)}
            onQueueAndSend={(p) => {
              setQueuedPrompt(p);
              void sendWith(p);
            }}
          />
        )}
      </div>
    </div>
  );
}
