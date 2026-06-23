import { ListTree, MessageSquare, Network, ScrollText, type LucideIcon } from 'lucide-react';

import type { TranscriptMode } from './use-transcript-mode';

interface Props {
  mode: TranscriptMode;
  onChange: (mode: TranscriptMode) => void;
}

const MODES: { mode: TranscriptMode; icon: LucideIcon; label: string; title: string }[] = [
  { mode: 'chat', icon: MessageSquare, label: 'Chat', title: 'Chat view' },
  { mode: 'trace', icon: ScrollText, label: 'Trace', title: 'Trace view' },
  { mode: 'callstack', icon: Network, label: 'Call stack', title: 'Call stack — which assets were called, by whom' },
  { mode: 'execution', icon: ListTree, label: 'Execution', title: 'Execution trace' },
];

export function ViewModeToggle({ mode, onChange }: Props) {
  const activeClass = 'bg-primary text-primary-foreground';
  const inactiveClass = 'text-muted-foreground hover:bg-muted hover:text-foreground';

  return (
    <div className="flex items-center rounded border border-border overflow-hidden text-xs">
      {MODES.map(({ mode: m, icon: Icon, label, title }) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          data-testid={`transcript-mode-chip-${m}`}
          data-mode-active={mode === m ? 'true' : 'false'}
          className={`flex items-center gap-1 px-2 py-1 transition-colors ${mode === m ? activeClass : inactiveClass}`}
          title={title}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </div>
  );
}
