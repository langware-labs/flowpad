import { t } from '@lingui/core/macro';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import {
  AttachFilesButton,
  PickedFileList,
  useAnnotatedImagePaste,
  usePickedFiles,
} from '@src/components/conversation/FileAttachmentPicker';
import { cn } from '@src/lib/utils';
import { Send } from 'lucide-react';
import React, { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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

  // Grow with the text so a long prompt stays readable; past the max-height cap it scrolls.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [message]);

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

  // Image paste: annotated, then chips (uploaded on submit); the caption joins the message.
  // The parent owns `message` through a plain-string onChange, so the update is applied here;
  // the annotator is modal, so `message` can't change under it.
  const applyToMessage = useCallback(
    (update: (prev: string) => string) => setMessage(update(message)),
    [message, setMessage],
  );
  const handlePaste = useAnnotatedImagePaste(picker.addFiles, {
    enabled: allowAttachments && !disabled,
    setText: applyToMessage,
  });

  const hasFooterControls = allowAttachments || Boolean(footerSlot);
  const sendButton = (
    <Button
      type="submit"
      disabled={!canSubmit || disabled}
      className={cn(
        'shrink-0 rounded-full bg-gradient-to-r from-primary to-primary/80 text-white',
        !hasFooterControls && 'absolute bottom-1 end-1',
      )}
      data-testid="session-input-submit"
    >
      <Send className="h-4 w-4 rtl:-scale-x-100" />
    </Button>
  );

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
        className="shrink-0 px-1 pt-1"
      />
      {/* Without footer controls the send button sits in the text's bottom corner,
          so the box doesn't reserve an empty row just for it. The box never shrinks
          (a shrinking flex column has no floor, so the text and footer spilled out
          of it); instead the textarea grows only up to max-h, then scrolls. */}
      <div className="relative flex flex-col">
        <Textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={picker.dragging ? undefined : placeholder}
          aria-label={placeholder || 'Session input'}
          className={cn(
            'max-h-[30vh] min-h-[40px] resize-none overflow-y-auto border-none shadow-none focus-visible:ring-0 focus-visible:ring-offset-0',
            !hasFooterControls && 'pe-14',
          )}
          disabled={disabled}
          rows={1}
        />
        {!hasFooterControls && sendButton}
      </div>
      {hasFooterControls && (
        <div className="flex shrink-0 items-center justify-between gap-2">
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
          {sendButton}
        </div>
      )}
    </form>
  );
}
