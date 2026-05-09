import type { TokenUsageEntry } from '@sdk/utils/agent-transcript';

interface Props {
  entry: TokenUsageEntry;
}

const fmt = (n: number | null | undefined): string => (n == null ? '–' : String(n));

export function TokenUsageView({ entry }: Props) {
  const parts: string[] = [];
  if (entry.input_tokens != null) parts.push(`in=${fmt(entry.input_tokens)}`);
  if (entry.output_tokens != null) parts.push(`out=${fmt(entry.output_tokens)}`);
  if (entry.cached_input_tokens != null) parts.push(`cached=${fmt(entry.cached_input_tokens)}`);
  if (entry.reasoning_output_tokens != null) parts.push(`reasoning=${fmt(entry.reasoning_output_tokens)}`);
  if (entry.total_input_tokens != null) parts.push(`total_in=${fmt(entry.total_input_tokens)}`);
  if (entry.total_output_tokens != null) parts.push(`total_out=${fmt(entry.total_output_tokens)}`);

  return (
    <div
      className="inline-flex items-center gap-2 rounded bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
      data-entry-kind="token_usage"
      data-entry-id={entry.id}
      data-entry-ts={entry.timestamp}
    >
      <span>tokens:</span>
      {parts.length === 0 ? <span>–</span> : <span>{parts.join(' ')}</span>}
      {entry.model && <span>· {entry.model}</span>}
    </div>
  );
}
