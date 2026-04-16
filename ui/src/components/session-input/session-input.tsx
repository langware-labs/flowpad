import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { Send } from 'lucide-react';
import React, { useCallback, useState } from 'react';

interface SessionInputProps {
  placeholder?: string;
  onSubmit: (message: string) => void;
  disabled?: boolean;
  /** Optional controlled value. When provided, onChange becomes authoritative. */
  value?: string;
  onChange?: (value: string) => void;
}

export function SessionInput({ placeholder, onSubmit, disabled = false, value, onChange }: SessionInputProps) {
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

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!message.trim() || disabled) return;
      onSubmit(message);
      setMessage('');
    },
    [message, disabled, onSubmit],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-full flex-col gap-2 rounded-md border bg-accent/50 p-1 shadow-sm ring-offset-background focus-within:outline-none focus-within:ring-1 focus-within:ring-ring"
    >
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder || 'Session input'}
        className="min-h-[40px] flex-1 resize-none border-none shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        disabled={disabled}
        rows={1}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={!message.trim() || disabled}
          className="rounded-full bg-gradient-to-r from-primary to-primary/80 text-white"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
