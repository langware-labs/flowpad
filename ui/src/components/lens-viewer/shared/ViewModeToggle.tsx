import { MessageSquare, ScrollText } from 'lucide-react';

import type { TranscriptMode } from './use-transcript-mode';

interface Props {
  mode: TranscriptMode;
  onChange: (mode: TranscriptMode) => void;
}

export function ViewModeToggle({ mode, onChange }: Props) {
  const activeClass = 'bg-primary text-primary-foreground';
  const inactiveClass = 'text-muted-foreground hover:bg-muted hover:text-foreground';

  return (
    <div className="flex items-center rounded border border-border overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => onChange('chat')}
        data-testid="transcript-mode-chip-chat"
        data-mode-active={mode === 'chat' ? 'true' : 'false'}
        className={`flex items-center gap-1 px-2 py-1 transition-colors ${mode === 'chat' ? activeClass : inactiveClass}`}
        title="Chat view"
      >
        <MessageSquare className="h-3 w-3" />
        Chat
      </button>
      <button
        type="button"
        onClick={() => onChange('trace')}
        data-testid="transcript-mode-chip-trace"
        data-mode-active={mode === 'trace' ? 'true' : 'false'}
        className={`flex items-center gap-1 px-2 py-1 transition-colors ${mode === 'trace' ? activeClass : inactiveClass}`}
        title="Trace view"
      >
        <ScrollText className="h-3 w-3" />
        Trace
      </button>
    </div>
  );
}
