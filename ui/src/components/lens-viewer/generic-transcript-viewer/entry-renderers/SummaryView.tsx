import { BookOpen } from 'lucide-react';
import type { SummaryEntry } from '@sdk/utils/agent-transcript';

interface Props {
  entry: SummaryEntry;
}

export function SummaryView({ entry }: Props) {
  return (
    <div
      className="rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs"
      data-entry-kind="summary"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
    >
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-amber-600">
        <BookOpen className="h-3 w-3" />
        summary
      </div>
      <pre className="whitespace-pre-wrap break-words font-sans">{entry.summary_text}</pre>
    </div>
  );
}
