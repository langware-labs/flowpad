import { cn } from '@src/lib/utils';
import { CornerDownLeft } from 'lucide-react';
import { useCallback, useState } from 'react';

interface ChatInputBoxProps {
  onSubmit: (content: string) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
}

/**
 * ChatInputBox - Terminal-style input for injecting instructions
 */
export function ChatInputBox({ onSubmit, disabled = false, className }: ChatInputBoxProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(() => {
    if (!inputValue.trim() || isSubmitting || disabled) return;

    setIsSubmitting(true);
    try {
      void onSubmit(inputValue.trim());
      setInputValue('');
    } finally {
      setIsSubmitting(false);
    }
  }, [inputValue, isSubmitting, disabled, onSubmit]);

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
        'flex items-center gap-2 border-t border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-950',
        className,
      )}
    >
      {/* Terminal prompt */}
      <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-500">▸</span>

      {/* Input field */}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="instruction..."
        className={cn(
          'h-6 flex-1 border-0 bg-transparent font-mono text-[12px] text-zinc-700 placeholder:text-zinc-400 focus:outline-none focus:ring-0 dark:text-zinc-300 dark:placeholder:text-zinc-600',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        disabled={disabled || isSubmitting}
      />

      {/* Submit hint */}
      <div className="flex items-center gap-1 font-mono text-[10px] text-zinc-400 dark:text-zinc-600">
        <CornerDownLeft className="h-3 w-3" />
        <span className="uppercase tracking-wider">enter</span>
      </div>
    </div>
  );
}
