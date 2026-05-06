import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { ToolUseEntry } from '@sdk/utils/agent-transcript';

interface Props {
  entry: ToolUseEntry;
  defaultOpen?: boolean;
}

export function ToolUseView({ entry, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const argsJson = JSON.stringify(entry.tool_input, null, 2);
  const argsLong = argsJson.length > 200;

  return (
    <div
      className="rounded border border-border bg-muted/20"
      data-entry-kind="tool_use"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
      data-tool-use-id={entry.tool_use_id}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted/40"
      >
        {argsLong ? (
          open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
        ) : (
          <span className="h-3 w-3" />
        )}
        <Wrench className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono font-medium">{entry.tool_name}</span>
        <span className="truncate text-muted-foreground">{argsLong ? '…' : argsJson}</span>
      </button>
      {(open || !argsLong) && argsLong && (
        <pre className="overflow-x-auto whitespace-pre border-t border-border bg-background px-2 py-1 font-mono text-[11px]">
          {argsJson}
        </pre>
      )}
    </div>
  );
}
