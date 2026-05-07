import { cn } from '@src/lib/utils';
import { Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface CompactExecutionInputProps {
  onSend: (text: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Optional node rendered between the textarea and the Send button (e.g. a status indicator). */
  statusSlot?: ReactNode;
}

/**
 * Compact textarea + send-button input for the entity-execution-panel.
 * Deliberately minimal — no uploads, tools panel, codebase connectors, or login flows.
 * Enter sends; Shift+Enter inserts a newline.
 */
export function CompactExecutionInput({
  onSend,
  disabled = false,
  placeholder = 'Ask about this doc…',
  className,
  statusSlot,
}: CompactExecutionInputProps) {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Autosize up to 6 rows.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 144)}px`;
  }, [value]);

  const send = useCallback(async () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    await onSend(text);
  }, [value, disabled, onSend]);

  return (
    <div className={cn('flex items-end gap-1 border-t bg-background px-2 py-1.5', className)}>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        className="min-h-[28px] flex-1 resize-none rounded border bg-transparent px-2 py-1 text-xs outline-none focus:border-primary disabled:opacity-50"
        data-testid="entity-execution-input"
      />
      {statusSlot}
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); void send(); }}
        disabled={disabled || !value.trim()}
        title="Send"
        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        data-testid="entity-execution-send"
      >
        <Send className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
