import { cn } from '@src/lib/utils';
import { imageFilesFromClipboardData } from '@src/utils/clipboard-image';
import { Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';

interface CompactExecutionInputProps {
  onSend: (text: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Optional node rendered between the textarea and the Send button (e.g. a status indicator). */
  statusSlot?: ReactNode;
  /** When true, the agent is mid-turn: show a Stop button instead of Send. */
  running?: boolean;
  /** Interrupt the in-flight turn. Presentational only — the pane owns the logic. */
  onStop?: () => void | Promise<void>;
  /** Drop the container's top border + background so it nests inside another ribbon. */
  bare?: boolean;
  /** Optional node rendered at the start of the row (e.g. a mode pill). */
  leadingSlot?: ReactNode;
  /** Shift+Tab handler (e.g. toggle plan mode). Intercepted before the textarea. */
  onShiftTab?: () => void;
  /**
   * Handle pasted image files (upload to the process input dir, open the Files
   * side tab, etc). Returns one reference line per uploaded image — these are
   * inserted into the composer at the caret so they ride along with the next
   * send, mirroring the PTY paste behaviour. Omit to leave paste as plain text.
   */
  onPasteImages?: (files: File[]) => Promise<string[] | void> | string[] | void;
}

/**
 * Textarea + send/stop input for the chat surfaces. Deliberately minimal — no
 * uploads, tools panel, codebase connectors, or login flows. Enter sends;
 * Shift+Enter inserts a newline; Cmd/Ctrl+Enter also sends. While `running`,
 * the Send button becomes a Stop button wired to `onStop`.
 */
export function CompactExecutionInput({
  onSend,
  disabled = false,
  placeholder,
  className,
  statusSlot,
  running = false,
  onStop,
  bare = false,
  onPasteImages,
  leadingSlot,
  onShiftTab,
}: CompactExecutionInputProps) {
  const { t } = useLingui();
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Autosize the textarea up to ~200px. Keep overflow hidden until the content
  // genuinely exceeds the cap — otherwise the border-box border leaves a ~2px
  // overflow and the browser shows a spurious vertical scrollbar.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const full = ta.scrollHeight;
    ta.style.height = `${Math.min(full, 200)}px`;
    ta.style.overflowY = full > 200 ? 'auto' : 'hidden';
  }, [value]);

  const send = useCallback(async () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    await onSend(text);
  }, [value, disabled, onSend]);

  // Image paste: hand the image files to the owner (upload + open Files tab),
  // then splice the returned reference line(s) into the textarea at the caret.
  // Non-image pastes fall through to the browser's default text paste.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onPasteImages || disabled) return;
      const images = imageFilesFromClipboardData(e.clipboardData, new Date(), { prefix: 'screenshot' });
      if (images.length === 0) return;
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart ?? value.length;
      const end = ta.selectionEnd ?? start;
      void Promise.resolve(onPasteImages(images)).then((refs) => {
        if (!refs || refs.length === 0) return;
        const insert = refs.join('\n');
        setValue((prev) => `${prev.slice(0, start)}${insert}${prev.slice(end)}`);
        requestAnimationFrame(() => {
          const node = taRef.current;
          if (!node) return;
          const caret = start + insert.length;
          node.focus();
          node.selectionStart = caret;
          node.selectionEnd = caret;
        });
      });
    },
    [onPasteImages, disabled, value],
  );

  const showStop = running && !!onStop;

  return (
    <div className={cn('flex flex-shrink-0 items-end gap-2', !bare && 'border-t bg-background px-3 py-2.5', className)}>
      {leadingSlot}
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={handlePaste}
        onKeyDown={(e) => {
          if (onShiftTab && e.key === 'Tab' && e.shiftKey) {
            e.preventDefault();
            onShiftTab();
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && (!e.nativeEvent.isComposing || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={disabled}
        placeholder={placeholder ?? t`Message the agent…`}
        rows={1}
        aria-label={t`Message the agent`}
        className="min-h-[44px] flex-1 resize-none overflow-y-hidden rounded-2xl border bg-background px-4 py-3 text-[15px] outline-none transition-colors focus:border-primary disabled:opacity-50"
        data-testid="entity-execution-input"
      />
      {statusSlot}
      {showStop ? (
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            void onStop?.();
          }}
          title={t`Stop generating`}
          aria-label={t`Stop generating`}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          data-testid="entity-execution-stop"
        >
          <Square className="h-3.5 w-3.5 fill-current" />
        </button>
      ) : (
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            void send();
          }}
          disabled={disabled || !value.trim()}
          title={t`Send`}
          aria-label={t`Send message`}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-primary"
          data-testid="entity-execution-send"
        >
          <Send className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
