import { MessageSquare } from 'lucide-react';
import React, { useState } from 'react';
import { cn } from '@src/lib/utils';

export interface PromptEntry {
  absRow: number | null;
  text: string;
  time: string;
  source: 'annotation' | 'trace';
}

interface PromptIndexPanelProps {
  prompts: PromptEntry[];
  onScrollToLine: (absRow: number) => void;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

const PromptItem: React.FC<{
  entry: PromptEntry;
  onScrollToLine: (absRow: number) => void;
}> = ({ entry, onScrollToLine }) => {
  const [expanded, setExpanded] = useState(false);

  const handleClick = () => {
    setExpanded((v) => !v);
    if (entry.absRow !== null) {
      onScrollToLine(entry.absRow);
    }
  };

  const preview = entry.text.length > 80 ? entry.text.slice(0, 80) + '…' : entry.text;

  return (
    <div
      className="cursor-pointer rounded px-2 py-1.5 hover:bg-muted/50"
      onClick={handleClick}
    >
      <div className="flex items-start gap-1.5">
        <span className={cn(
          'mt-0.5 shrink-0 text-[9px] font-bold uppercase',
          entry.source === 'annotation' ? 'text-lime-400' : 'text-sky-400',
        )}>
          {entry.source === 'annotation' ? 'A' : 'T'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[10px] text-muted-foreground">{formatTime(entry.time)}</span>
            {entry.absRow !== null && (
              <span className="shrink-0 text-[9px] text-muted-foreground/60">→ {entry.absRow}</span>
            )}
          </div>
          {expanded ? (
            <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">
              {entry.text}
            </pre>
          ) : (
            <p className="mt-0.5 text-xs text-foreground/80">{preview}</p>
          )}
        </div>
      </div>
    </div>
  );
};

export const PromptIndexPanel: React.FC<PromptIndexPanelProps> = ({
  prompts,
  onScrollToLine,
}) => {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        <MessageSquare className="h-3.5 w-3.5 text-lime-400" />
        <span className="text-sm font-medium">Prompts ({prompts.length})</span>
      </div>

      <div className="flex-1 overflow-y-auto p-1">
        {prompts.length === 0 ? (
          <p className="mt-4 px-2 text-center text-xs text-muted-foreground">No prompts yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {prompts.map((entry, i) => (
              <PromptItem key={`${entry.time}-${i}`} entry={entry} onScrollToLine={onScrollToLine} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
