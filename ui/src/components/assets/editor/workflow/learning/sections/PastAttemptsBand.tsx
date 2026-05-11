import { MarkdownView } from '@src/components/markdown-view';
import { cn } from '@src/lib/utils';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { useMemo, useState } from 'react';

interface PastAttemptsBandProps {
  learningLog: string | null;
  stickyTop?: number;
}

export function PastAttemptsBand({ learningLog, stickyTop = 0 }: PastAttemptsBandProps) {
  const [open, setOpen] = useState(false);
  const entryCount = useMemo(() => (learningLog?.match(/^## /gm) || []).length, [learningLog]);
  return (
    <div
      className={cn('z-10 border-b bg-background')}
      style={{ position: 'sticky', top: stickyTop }}
      data-testid="learning-past-attempts-band"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={entryCount === 0}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground transition-colors',
          entryCount > 0 ? 'hover:bg-muted/40' : 'cursor-default',
        )}
      >
        {entryCount > 0 ? (
          open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
        ) : (
          <span className="w-3" />
        )}
        <History className="h-3.5 w-3.5" />
        <span className="font-medium uppercase tracking-wide">Past attempts</span>
        <span className="ml-1">· {entryCount}</span>
      </button>
      {open && entryCount > 0 && learningLog && (
        <div className="max-h-[40vh] overflow-y-auto border-t bg-muted/20 px-4 py-3">
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <MarkdownView value={learningLog} compact />
          </div>
        </div>
      )}
    </div>
  );
}
