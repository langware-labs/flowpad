import { Send } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { useLingui } from '@lingui/react/macro';

export function MessageInput() {
  const { t } = useLingui();
  const [value, setValue] = useState('');

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    // Mock — wire to real chat later.
    console.log('[CollaborationSpaceChat] send:', trimmed);
    setValue('');
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex items-center gap-2 border-t px-3 py-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        placeholder={t`Message this space…`}
        className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/50"
      />
      <button
        onClick={submit}
        className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        disabled={!value.trim()}
        title={t`Send`}
      >
        <Send className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
