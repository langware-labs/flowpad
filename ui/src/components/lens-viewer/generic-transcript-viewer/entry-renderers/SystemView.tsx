import { useState } from 'react';
import { ChevronDown, ChevronRight, Cog } from 'lucide-react';
import type { SystemEntry } from '@sdk/utils/agent-transcript';

interface Props {
  entry: SystemEntry;
}

export function SystemView({ entry }: Props) {
  const [open, setOpen] = useState(false);
  const hasPayload = entry.payload && Object.keys(entry.payload).length > 0;

  return (
    <div
      className="rounded border border-dashed border-muted-foreground/30 bg-muted/20"
      data-entry-kind="system"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted/40"
      >
        {hasPayload ? (
          open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
        ) : (
          <span className="h-3 w-3" />
        )}
        <Cog className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono text-muted-foreground">{entry.subtype}</span>
      </button>
      {open && hasPayload && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border bg-background px-2 py-1 font-mono text-[11px]">
          {JSON.stringify(entry.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
