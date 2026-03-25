import { cn } from '@src/lib/utils';
import { CornerDownLeft } from 'lucide-react';
import { useCallback, useState } from 'react';

interface PendingInjectionCardProps {
  inputId: string | null;
  onSubmit: (value: string) => void | Promise<void>;
  className?: string;
}

/**
 * PendingInjectionCard - Terminal-style input when session is waiting
 */
export function PendingInjectionCard({ inputId, onSubmit, className }: PendingInjectionCardProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(() => {
    if (!inputValue.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      void onSubmit(inputValue.trim());
      setInputValue('');
    } finally {
      setIsSubmitting(false);
    }
  }, [inputValue, isSubmitting, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div
      className={cn(
        'flex items-center gap-2 border-l-2 border-t border-amber-500 border-t-zinc-200 bg-amber-50 px-3 py-1.5 dark:border-t-zinc-800 dark:bg-zinc-950',
        className,
      )}
    >
      {/* Blinking cursor indicator */}
      <span className="animate-pulse font-mono text-[11px] text-amber-600 dark:text-amber-400">▸</span>

      {/* Waiting label */}
      <span className="font-mono text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-500">await</span>

      {/* Input ID if present */}
      {inputId && (
        <>
          <span className="font-mono text-amber-300 dark:text-zinc-700">│</span>
          <span className="font-mono text-[10px] text-zinc-500">{inputId}</span>
        </>
      )}

      {/* Separator */}
      <span className="font-mono text-amber-300 dark:text-zinc-700">│</span>

      {/* Input field */}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="input..."
        className="h-6 flex-1 border-0 bg-transparent font-mono text-[12px] text-zinc-700 placeholder:text-zinc-400 focus:outline-none focus:ring-0 dark:text-zinc-300 dark:placeholder:text-zinc-600"
        disabled={isSubmitting}
        autoFocus
      />

      {/* Submit hint */}
      <div className="flex items-center gap-1 font-mono text-[10px] text-zinc-400 dark:text-zinc-600">
        <CornerDownLeft className="h-3 w-3" />
        <span className="uppercase tracking-wider">enter</span>
      </div>
    </div>
  );
}
