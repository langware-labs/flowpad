import { t } from '@lingui/core/macro';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { annotateImageFiles } from '@src/components/image-annotator/annotate-files';
import { AttachFilesButton, PickedFileList, usePickedFiles } from '@src/components/conversation/FileAttachmentPicker';
import { cn } from '@src/lib/utils';
import { imageFilesFromClipboardData } from '@src/utils/clipboard-image';
import { Send } from 'lucide-react';
import React, { useCallback, useState, type ReactNode } from 'react';

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
  /** Optional controls rendered next to the attachment button. */
  footerSlot?: ReactNode;
}

export function SessionInput({
  placeholder,
  onSubmit,
  disabled = false,
  value,
  onChange,
  allowAttachments = false,
  footerSlot,
}: SessionInputProps) {
  const [internal, setInternal] = useState('');
  const controlled = value !== undefined;
  const message = controlled ? (value ?? '') : internal;
  const setMessage = useCallback(
    (next: string) => {
      if (controlled) {
        onChange?.(next);
      } else {
        setInternal(next);
      }
    },
    [controlled, onChange],
  );

  const picker = usePickedFiles({ enabled: allowAttachments, disabled });
  const files = picker.files;

  // files can only be non-empty when allowAttachments is on (every add path is gated).
  const canSubmit = Boolean(message.trim() || files.length);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!canSubmit || disabled) return;
      onSubmit(message, files.length ? files : undefined);
      setMessage('');
      picker.clear();
    },
    [message, files, canSubmit, disabled, onSubmit, setMessage, picker],
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
      if (annotated.length) picker.addFiles(annotated);
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      {...picker.dragProps}
      className={cn(
        'flex w-full flex-col gap-2 rounded-md border bg-accent/50 p-1 shadow-sm ring-offset-background focus-within:outline-none focus-within:ring-1 focus-within:ring-ring',
        picker.dragging && 'border-primary ring-1 ring-primary',
      )}
    >
      <PickedFileList
        files={files}
        rejected={picker.rejected}
        disabled={disabled}
        onRemoveAt={picker.removeAt}
        className="px-1 pt-1"
      />
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={picker.dragging ? undefined : placeholder}
        aria-label={placeholder || 'Session input'}
        className="min-h-[40px] flex-1 resize-none border-none shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        disabled={disabled}
        rows={1}
      />
      <div
        className={cn('flex items-center gap-2', allowAttachments || footerSlot ? 'justify-between' : 'justify-end')}
      >
        {(allowAttachments || footerSlot) && (
          <div className="flex min-w-0 items-center gap-1.5">
            {allowAttachments && (
              <AttachFilesButton
                inputId={picker.inputId}
                onFiles={picker.addFiles}
                disabled={disabled}
                title={t`Attach files`}
                testId="session-input-attach"
              />
            )}
            {footerSlot}
          </div>
        )}
        <Button
          type="submit"
          disabled={!canSubmit || disabled}
          className="rounded-full bg-gradient-to-r from-primary to-primary/80 text-white"
          data-testid="session-input-submit"
        >
          <Send className="h-4 w-4 rtl:-scale-x-100" />
        </Button>
      </div>
    </form>
  );
}
