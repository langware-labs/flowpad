import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { annotateImageFiles } from '@src/components/image-annotator/annotate-files';
import { mergePickedFiles, PickedFileRow, rejectedFilesNotice } from '@src/components/conversation/FileAttachmentPicker';
import { cn } from '@src/lib/utils';
import { imageFilesFromClipboardData } from '@src/utils/clipboard-image';
import { Plus, Send } from 'lucide-react';
import React, { useCallback, useId, useState } from 'react';

interface SessionInputProps {
  placeholder?: string;
  onSubmit: (message: string, files?: File[]) => void;
  disabled?: boolean;
  /** Optional controlled value. When provided, onChange becomes authoritative. */
  value?: string;
  onChange?: (value: string) => void;
  /** Opt-in attachments mode: image paste (through the annotator, matching the
   *  vibe workspace composer), drag-and-drop, a "+" picker button, and file
   *  chips. Picked files are held locally and handed to onSubmit — the caller
   *  uploads them (there may be no process yet to upload into). */
  allowAttachments?: boolean;
}

export function SessionInput({
  placeholder,
  onSubmit,
  disabled = false,
  value,
  onChange,
  allowAttachments = false,
}: SessionInputProps) {
  const [internal, setInternal] = useState('');
  const controlled = value !== undefined;
  const message = controlled ? (value ?? '') : internal;
  const setMessage = (next: string) => {
    if (controlled) {
      onChange?.(next);
    } else {
      setInternal(next);
    }
  };

  const fileInputId = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Functional updater, not a read of `files` from the closure — successive
  // adds (e.g. a drop landing while a paste's annotator resolves) must merge
  // into the latest state, not clobber it with a stale snapshot.
  const addFiles = useCallback((incoming: FileList | File[] | null) => {
    setFiles((existing) => {
      const merged = mergePickedFiles(existing, incoming);
      setRejected(rejectedFilesNotice(merged.rejectedNames));
      return merged.files;
    });
  }, []);

  // files can only be non-empty when allowAttachments is on (every add path is gated).
  const canSubmit = Boolean(message.trim() || files.length);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!canSubmit || disabled) return;
      onSubmit(message, files.length ? files : undefined);
      setMessage('');
      setFiles([]);
      setRejected(null);
    },
    [message, files, canSubmit, disabled, onSubmit],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Image paste — same annotator popup flow as the vibe workspace composer;
  // cancelled images are dropped. Survivors become chips (uploaded on submit).
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!allowAttachments || disabled) return;
    const images = imageFilesFromClipboardData(e.clipboardData);
    if (!images.length) return;
    e.preventDefault();
    void annotateImageFiles(images).then((annotated) => {
      if (annotated.length) addFiles(annotated);
    });
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!allowAttachments) return;
    e.preventDefault();
    if (!disabled) setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    if (!allowAttachments) return;
    e.preventDefault();
    setDragging(false);
    if (!disabled) addFiles(e.dataTransfer.files);
  };

  return (
    <form
      onSubmit={handleSubmit}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex w-full flex-col gap-2 rounded-md border bg-accent/50 p-1 shadow-sm ring-offset-background focus-within:outline-none focus-within:ring-1 focus-within:ring-ring',
        dragging && 'border-primary ring-1 ring-primary',
      )}
    >
      {allowAttachments && files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-1 pt-1 text-left">
          {/* name+size is unique (mergePickedFiles dedupes on it); no index in
              the key so removal doesn't remount later chips' object URLs. */}
          {files.map((f, i) => (
            <PickedFileRow
              key={`${f.name}-${f.size}`}
              file={f}
              disabled={disabled}
              onRemove={() => setFiles((existing) => existing.filter((_, idx) => idx !== i))}
            />
          ))}
        </ul>
      )}
      {allowAttachments && rejected && <p className="px-1 text-left text-[11px] text-destructive">{rejected}</p>}
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={dragging ? undefined : placeholder}
        aria-label={placeholder || 'Session input'}
        className="min-h-[40px] flex-1 resize-none border-none shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        disabled={disabled}
        rows={1}
      />
      <div className={cn('flex items-center', allowAttachments ? 'justify-between' : 'justify-end')}>
        {allowAttachments && (
          <>
            {/* <label htmlFor> so a real native click opens the OS picker
                reliably (see FileAttachmentPicker for why). */}
            <label
              htmlFor={fileInputId}
              title="Attach files"
              className={cn(
                'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                disabled && 'pointer-events-none opacity-50',
              )}
              data-testid="session-input-attach"
            >
              <Plus className="h-4 w-4" />
            </label>
            <input
              id={fileInputId}
              type="file"
              multiple
              className="sr-only"
              disabled={disabled}
              onChange={(e) => addFiles(e.target.files)}
              onClick={(e) => ((e.target as HTMLInputElement).value = '')}
            />
          </>
        )}
        <Button
          type="submit"
          disabled={!canSubmit || disabled}
          className="rounded-full bg-gradient-to-r from-primary to-primary/80 text-white"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
