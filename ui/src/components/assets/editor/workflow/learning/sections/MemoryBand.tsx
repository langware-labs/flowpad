import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface MemoryBandProps {
  memory: string | null;
  stickyTop?: number;
}

export function MemoryBand({ memory, stickyTop = 0 }: MemoryBandProps) {
  const [open, setOpen] = useState(false);
  const sizeText = memory ? `${new Blob([memory]).size} B` : 'empty';
  return (
    <div
      className={cn('z-20 border-b bg-background')}
      style={{ position: 'sticky', top: stickyTop }}
      data-testid="learning-memory-band"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!memory?.trim()}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground transition-colors',
          memory?.trim() ? 'hover:bg-muted/40' : 'cursor-default',
        )}
      >
        {memory?.trim() ? (
          open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
        ) : (
          <span className="w-3" />
        )}
        <Brain className="h-3.5 w-3.5" />
        <span className="font-medium uppercase tracking-wide">Memory</span>
        <span className="ml-1">· {sizeText}</span>
      </button>
      {open && memory?.trim() && (
        <div className="border-t bg-muted/20 px-4 py-3">
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <MarkdownView value={memory} compact />
          </div>
        </div>
      )}
    </div>
  );
}
