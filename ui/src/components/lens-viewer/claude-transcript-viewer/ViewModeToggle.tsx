import { MessageSquare, ScrollText } from 'lucide-react';

interface Props {
  mode: 'chat' | 'transcript';
  onChange: (mode: 'chat' | 'transcript') => void;
}

export function ViewModeToggle({ mode, onChange }: Props) {
  const activeClass = 'bg-primary text-primary-foreground';
  const inactiveClass = 'text-muted-foreground hover:bg-muted hover:text-foreground';

  return (
    <div className="flex items-center rounded border border-border overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => onChange('chat')}
        className={`flex items-center gap-1 px-2 py-1 transition-colors ${mode === 'chat' ? activeClass : inactiveClass}`}
        title="Chat view"
      >
        <MessageSquare className="h-3 w-3" />
        Chat
      </button>
      <button
        type="button"
        onClick={() => onChange('transcript')}
        className={`flex items-center gap-1 px-2 py-1 transition-colors ${mode === 'transcript' ? activeClass : inactiveClass}`}
        title="Transcript view"
      >
        <ScrollText className="h-3 w-3" />
        Transcript
      </button>
    </div>
  );
}
