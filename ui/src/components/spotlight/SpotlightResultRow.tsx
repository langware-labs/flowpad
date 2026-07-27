import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { TYPE_COLORS } from '@src/components/record-search-bar/RecordSearchBar';
import { cn } from '@src/lib/utils';
import { FileText, Loader2 } from 'lucide-react';
import { timeAgo } from './adapters';
import type { SpotlightRow } from './types';

/**
 * Per-result-type leading icon. Worker sessions get their vendor glyph; every
 * other record type gets a generic doc badge tinted by `TYPE_COLORS`. Shared by
 * the global Spotlight modal and the inline navigator search so both render
 * results identically.
 */
export function RowIcon({ recordType }: { recordType: string }) {
  if (recordType === 'claude_session') return <ClaudeIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" />;
  if (recordType === 'codex_session') return <CodexIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  if (recordType === 'copilot_session') return <CopilotIcon className="h-3.5 w-3.5 shrink-0 text-sky-500" />;
  const color = TYPE_COLORS[recordType];
  return (
    <span
      className={cn(
        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded',
        color ?? 'bg-muted text-muted-foreground',
      )}
    >
      <FileText className="h-2.5 w-2.5" />
    </span>
  );
}

/**
 * The inner content of a search-result row — icon + title/subtitle + trailing
 * timestamp (or a spinner while the row is opening). Presentational only; the
 * caller supplies the clickable wrapper (a cmdk `CommandItem` in Spotlight, a
 * plain button in the navigator search).
 */
export function SpotlightResultRowContent({ row, opening }: { row: SpotlightRow; opening?: boolean }) {
  return (
    <>
      <RowIcon recordType={row.recordType} />
      <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <span className="truncate text-sm">{row.title}</span>
        {row.subtitle && (
          <span className="truncate text-[10px] text-muted-foreground/70">{row.subtitle}</span>
        )}
      </span>
      {opening ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        row.timestamp && (
          <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(row.timestamp)}</span>
        )
      )}
    </>
  );
}
