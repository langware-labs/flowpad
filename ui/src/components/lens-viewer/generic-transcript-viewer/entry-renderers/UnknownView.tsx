import { HelpCircle } from 'lucide-react';
import type { UnknownEntry } from '@sdk/utils/agent-transcript';

interface Props {
  entry: UnknownEntry;
}

export function UnknownView({ entry }: Props) {
  return (
    <div
      className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs"
      data-entry-kind="unknown"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
    >
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-destructive">
        <HelpCircle className="h-3 w-3" />
        unknown
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
        {JSON.stringify(entry.raw_data, null, 2)}
      </pre>
    </div>
  );
}
