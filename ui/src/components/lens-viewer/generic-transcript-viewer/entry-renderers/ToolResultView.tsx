import { useState } from 'react';
import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { ToolResultEntry } from '@sdk/utils/agent-transcript';
import { formatDuration, formatNumber } from '../../shared/format-utils';

interface Props {
  entry: ToolResultEntry;
  defaultOpen?: boolean;
}

const PREVIEW_CHARS = 240;

export function ToolResultView({ entry, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const out = entry.tool_output ?? '';
  const truncated = out.length > PREVIEW_CHARS;
  const preview = truncated ? out.slice(0, PREVIEW_CHARS) + '…' : out;
  const Icon = entry.is_error ? AlertCircle : CheckCircle2;
  const iconClass = entry.is_error ? 'text-destructive' : 'text-emerald-600';

  const hasMeta =
    entry.duration_ms !== null && entry.duration_ms !== undefined ||
    entry.exit_code !== null && entry.exit_code !== undefined ||
    entry.output_token_count !== null && entry.output_token_count !== undefined;

  return (
    <div
      className="rounded border border-border bg-background"
      data-entry-kind="tool_result"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
      data-tool-use-id={entry.tool_use_id}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-2 py-1 text-left text-xs hover:bg-muted/40"
      >
        {truncated ? (
          open ? <ChevronDown className="mt-0.5 h-3 w-3 flex-shrink-0" /> : <ChevronRight className="mt-0.5 h-3 w-3 flex-shrink-0" />
        ) : (
          <span className="mt-0.5 h-3 w-3 flex-shrink-0" />
        )}
        <Icon className={`mt-0.5 h-3 w-3 flex-shrink-0 ${iconClass}`} />
        <span className="text-muted-foreground">
          {entry.tool_name ? <span className="font-mono">{entry.tool_name}</span> : 'result'}
          {entry.file_path && <span className="ml-1 text-[10px]">{entry.file_path}</span>}
        </span>
        {hasMeta && (
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {entry.duration_ms !== null && entry.duration_ms !== undefined && (
              <span>{formatDuration(entry.duration_ms)}</span>
            )}
            {entry.exit_code !== null && entry.exit_code !== undefined && (
              <span className={entry.exit_code !== 0 ? 'text-destructive' : ''}>
                exit: {entry.exit_code}
              </span>
            )}
            {entry.output_token_count !== null && entry.output_token_count !== undefined && (
              <span>tokens: {formatNumber(entry.output_token_count)}</span>
            )}
          </span>
        )}
        <pre className="ml-1 flex-1 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px]">
          {open ? out : preview}
        </pre>
      </button>
    </div>
  );
}
