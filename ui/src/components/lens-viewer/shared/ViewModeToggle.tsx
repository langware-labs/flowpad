import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { ListTree, MessageSquare, Network, ScrollText, type LucideIcon } from 'lucide-react';

import type { TranscriptMode } from './use-transcript-mode';

interface Props {
  mode: TranscriptMode;
  onChange: (mode: TranscriptMode) => void;
}

const MODES: { mode: TranscriptMode; icon: LucideIcon; label: MessageDescriptor; title: MessageDescriptor }[] = [
  { mode: 'chat', icon: MessageSquare, label: msg`Chat`, title: msg`Chat view` },
  { mode: 'trace', icon: ScrollText, label: msg`Trace`, title: msg`Trace view` },
  {
    mode: 'callstack',
    icon: Network,
    label: msg`Call stack`,
    title: msg`Call stack — which assets were called, by whom`,
  },
  { mode: 'execution', icon: ListTree, label: msg`Execution`, title: msg`Execution trace` },
];

export function ViewModeToggle({ mode, onChange }: Props) {
  const activeClass = 'bg-primary text-primary-foreground';
  const inactiveClass = 'text-muted-foreground hover:bg-muted hover:text-foreground';

  return (
    <div className="flex items-center overflow-hidden rounded border border-border text-xs">
      {MODES.map(({ mode: m, icon: Icon, label, title }) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          data-testid={`transcript-mode-chip-${m}`}
          data-mode-active={mode === m ? 'true' : 'false'}
          className={`flex items-center gap-1 px-2 py-1 transition-colors ${mode === m ? activeClass : inactiveClass}`}
          title={i18n._(title)}
        >
          <Icon className="h-3 w-3" />
          {i18n._(label)}
        </button>
      ))}
    </div>
  );
}
