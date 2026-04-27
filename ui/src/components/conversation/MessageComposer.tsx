import { useRef, useState } from 'react';
import { File, Paperclip, Send, X } from 'lucide-react';
import { sendReply } from '@sdk/entities/notifications';
import type { ITask } from '@sdk/entities/task';
import { cn } from '@src/lib/utils';

interface MessageComposerProps {
  task: ITask;
  disabled?: boolean;
  onSent?: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageComposer({ task, disabled, onSent }: MessageComposerProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendReply(task, trimmed, files.length > 0 ? files : undefined);
      setText('');
      setFiles([]);
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

  const canSend = !!text.trim() && !isDisabled;

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
          onClick={() => void handleSend()}
          disabled={!canSend}
          title="Send"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>

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
    </div>
  );
}
