import { cn } from '@src/lib/utils';
import { Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

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
  placeholder = 'Message the agent…',
  className,
  statusSlot,
  running = false,
  onStop,
  bare = false,
}: CompactExecutionInputProps) {
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

  const showStop = running && !!onStop;

  return (
    <div className={cn('flex items-end gap-2', !bare && 'border-t bg-background px-3 py-2.5', className)}>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && (!e.nativeEvent.isComposing || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        aria-label="Message the agent"
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
          title="Stop generating"
          aria-label="Stop generating"
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
          title="Send"
          aria-label="Send message"
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-primary"
          data-testid="entity-execution-send"
        >
          <Send className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
