import { CornerDownLeft } from 'lucide-react';
import React, { useCallback, useState } from 'react';

interface TerminalLineSessionInputProps {
  placeholder?: string;
  onSubmit: (message: string) => void;
  disabled?: boolean;
}

export function TerminalLineSessionInput({
  placeholder = 'Start new Claude Code session...',
  onSubmit,
  disabled = false,
}: TerminalLineSessionInputProps) {
  const [message, setMessage] = useState('');

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!message.trim() || disabled) return;
      onSubmit(message);
      setMessage('');
    },
    [message, disabled, onSubmit],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex w-full items-center gap-2 rounded-md border bg-accent/30 px-3 py-1.5 font-mono text-sm ring-offset-background transition-colors focus-within:bg-accent/50 focus-within:ring-1 focus-within:ring-ring">
      <span className="select-none text-muted-foreground/60">$</span>
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/50"
      />
      <button
        type="submit"
        disabled={!message.trim() || disabled}
        className="flex shrink-0 items-center text-muted-foreground/40 transition-colors hover:text-foreground disabled:pointer-events-none"
      >
        <CornerDownLeft className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}
