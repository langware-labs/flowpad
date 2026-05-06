import { useState } from 'react';
import { ChevronDown, ChevronRight, Tag } from 'lucide-react';
import type { MetaEntry } from '@sdk/utils/agent-transcript';

interface Props {
  entry: MetaEntry;
}

export function MetaView({ entry }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="rounded border border-border bg-muted/10"
      data-entry-kind="meta"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Tag className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono text-muted-foreground">{entry.meta_kind}</span>
      </button>
      {open && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border bg-background px-2 py-1 font-mono text-[11px]">
          {JSON.stringify(entry.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
