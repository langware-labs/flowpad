import { useMemo, useRef, useState } from 'react';
import { File, MessageSquarePlus, Paperclip, Send, X } from 'lucide-react';
import { sendReply } from '@sdk/entities/notifications';
import { AttachmentType, type Attachment } from '@sdk/entities/flow-message';
import type { ITask } from '@sdk/entities/task';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { cn } from '@src/lib/utils';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_LABEL } from './constants';
import { PromptComposerDialog, type QueuedPrompt } from './PromptComposerDialog';
import { PromptApprovalRow } from './PromptApprovalRow';

interface MessageComposerProps {
  /** Task-bound: triggers hub push + git commit on send. Project-scoped sends omit it. */
  task?: ITask | null;
  /** Project-scoped conversation id (used when no task is present). */
  conversationId?: string;
  disabled?: boolean;
  onSent?: () => void;
  /** Optional queued prompt provided by per-message Add-prompt chips. */
  queuedPrompt?: QueuedPrompt | null;
  /** Update / clear the externally-queued prompt. */
  onQueuedPromptChange?: (prompt: QueuedPrompt | null) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageComposer({ task, conversationId, disabled, onSent, queuedPrompt, onQueuedPromptChange }: MessageComposerProps) {
  const ensureCloudLogin = useCloudLoginGate();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localPrompt, setLocalPrompt] = useState<QueuedPrompt | null>(null);
  const [showPromptDialog, setShowPromptDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canAddPrompt = !!conversationId;

  const activePrompt = queuedPrompt ?? localPrompt;
  const setActivePrompt = (p: QueuedPrompt | null) => {
    if (onQueuedPromptChange) onQueuedPromptChange(p);
    else setLocalPrompt(p);
  };

  // Synthesise PROMPT-shaped attachments for the queued prompt so the preview
  // chip uses the same PromptApprovalRow component the message bubbles use.
  // One attachment per inline text + one per attached file (data="prompt/<name>").
  const queuedPromptAttachments: Attachment[] = useMemo(() => {
    if (!activePrompt) return [];
    const list: Attachment[] = [];
    if (activePrompt.text) {
      list.push({ attachment_type: AttachmentType.PROMPT, data: activePrompt.text });
    }
    for (const f of activePrompt.files) {
      list.push({ attachment_type: AttachmentType.PROMPT, data: `prompt/${f.name}` });
    }
    return list;
  }, [activePrompt]);

  const isDisabled = disabled || sending;

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
    if (tooBig.length > 0) {
      setError(
        tooBig.length === 1
          ? `"${tooBig[0]}" is over ${MAX_FILE_SIZE_LABEL} and was not attached.`
          : `${tooBig.length} files over ${MAX_FILE_SIZE_LABEL} were not attached: ${tooBig.join(', ')}.`,
      );
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async (override?: { prompt?: QueuedPrompt | null }) => {
    const trimmed = text.trim();
    if (sending) return;
    // `prompt` lives on either react state (queued from the dialog's "Attach to
    // reply") OR an explicit override (the dialog's "Send" button uses this so
    // we don't lose the prompt to a state-update race).
    const effectivePrompt = override && 'prompt' in override ? override.prompt : activePrompt;
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
        return;
      }
      const extras = effectivePrompt
        ? {
            promptText: effectivePrompt.text || undefined,
            promptFiles: effectivePrompt.files.length > 0 ? effectivePrompt.files : undefined,
          }
        : undefined;
      await sendReply(
        { task, conversationId },
        trimmed,
        files.length > 0 ? files : undefined,
        extras,
      );
      setText('');
      setFiles([]);
      setActivePrompt(null);
      onSent?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send reply.');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!isDisabled) setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!isDisabled) addFiles(e.dataTransfer.files);
  };

  const canSend = (!!text.trim() || !!activePrompt || files.length > 0) && !isDisabled;

  return (
    <div className="space-y-1.5">
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'flex items-end gap-2 rounded-md border border-border bg-background px-2 py-1.5 transition-colors focus-within:border-primary/50',
          dragging && 'border-primary bg-primary/5',
        )}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isDisabled}
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
          disabled={isDisabled}
          onChange={(e) => addFiles(e.target.files)}
          onClick={(e) => ((e.target as HTMLInputElement).value = '')}
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={dragging ? 'Drop files here' : 'Reply to sender…'}
          rows={1}
          disabled={isDisabled}
          className="min-h-[1.5rem] flex-1 resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        />
        {canAddPrompt && (
          <button
            type="button"
            onClick={() => setShowPromptDialog(true)}
            disabled={isDisabled}
            title={activePrompt ? 'Edit attached prompt' : 'Suggest a prompt for the other user to approve'}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-40',
              activePrompt
                ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300'
                : 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300',
            )}
          >
            <MessageSquarePlus className="h-3 w-3" />
            {activePrompt ? 'Edit prompt' : 'Suggest prompt'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          title="Send"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>

      {canAddPrompt && activePrompt && (
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <PromptApprovalRow attachments={queuedPromptAttachments} onEdit={() => setShowPromptDialog(true)} />
          </div>
          <button
            type="button"
            onClick={() => setActivePrompt(null)}
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
              <File className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-foreground" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-muted-foreground">{formatSize(f.size)}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                disabled={isDisabled}
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
          initial={activePrompt}
          onQueue={(p) => setActivePrompt(p)}
          onQueueAndSend={(p) => {
            // Park the prompt on state so the queued-prompt chip flashes
            // briefly during send, then ship it via an explicit override so
            // we don't lose it to React's setState batch.
            setActivePrompt(p);
            void handleSend({ prompt: p });
          }}
        />
      )}
    </div>
  );
}
