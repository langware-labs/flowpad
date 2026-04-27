import { useRef, useState } from 'react';
import { File, MessageSquarePlus, Paperclip, Send, X } from 'lucide-react';
import { sendReply } from '@sdk/entities/notifications';
import type { ITask } from '@sdk/entities/task';
import { cn } from '@src/lib/utils';
import { PromptComposerDialog, type QueuedPrompt } from './PromptComposerDialog';

interface MessageComposerProps {
  task: ITask;
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

export function MessageComposer({ task, disabled, onSent, queuedPrompt, onQueuedPromptChange }: MessageComposerProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localPrompt, setLocalPrompt] = useState<QueuedPrompt | null>(null);
  const [showPromptDialog, setShowPromptDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activePrompt = queuedPrompt ?? localPrompt;
  const setActivePrompt = (p: QueuedPrompt | null) => {
    if (onQueuedPromptChange) onQueuedPromptChange(p);
    else setLocalPrompt(p);
  };

  const isDisabled = disabled || sending;

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(incoming)) {
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      return next;
    });
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (sending) return;
    if (!trimmed && !activePrompt && files.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const extras = activePrompt
        ? {
            promptText: activePrompt.text || undefined,
            promptFiles: activePrompt.files.length > 0 ? activePrompt.files : undefined,
          }
        : undefined;
      await sendReply(task, trimmed, files.length > 0 ? files : undefined, extras);
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
  const sendNeedsAttention = canSend && !text.trim() && !!activePrompt;

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
        <button
          type="button"
          onClick={() => setShowPromptDialog(true)}
          disabled={isDisabled}
          title={activePrompt ? 'Edit attached prompt' : 'Add a prompt to your reply'}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-40',
            activePrompt
              ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300'
              : 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300',
          )}
        >
          <MessageSquarePlus className="h-3 w-3" />
          {activePrompt ? 'Edit prompt' : 'Add prompt'}
        </button>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          title={sendNeedsAttention ? 'Send prompt' : 'Send'}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-primary-foreground transition-colors disabled:opacity-40',
            sendNeedsAttention
              ? 'animate-pulse bg-emerald-600 ring-2 ring-emerald-400/60 hover:bg-emerald-700'
              : 'bg-primary hover:bg-primary/90',
          )}
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>

      {activePrompt && (
        <div className="flex items-start gap-2 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1 text-xs">
          <MessageSquarePlus className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <div className="text-emerald-700 dark:text-emerald-300">Prompt attached</div>
            {activePrompt.text && (
              <div className="mt-0.5 line-clamp-2 text-muted-foreground">{activePrompt.text}</div>
            )}
            {activePrompt.files.length > 0 && (
              <div className="mt-0.5 text-muted-foreground">
                {activePrompt.files.length} file{activePrompt.files.length === 1 ? '' : 's'}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowPromptDialog(true)}
            className="shrink-0 rounded px-1.5 py-0.5 text-emerald-700 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setActivePrompt(null)}
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
              <span className="flex-1 truncate text-foreground" title={f.name}>{f.name}</span>
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

      <PromptComposerDialog
        open={showPromptDialog}
        onClose={() => setShowPromptDialog(false)}
        initial={activePrompt}
        onQueue={(p) => setActivePrompt(p)}
      />
    </div>
  );
}
