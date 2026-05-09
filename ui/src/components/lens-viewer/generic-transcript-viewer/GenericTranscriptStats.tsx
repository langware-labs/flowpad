import type { ParsedTranscript, EntryKind } from '@sdk/utils/agent-transcript';
import { formatNumber } from '../shared/format-utils';

interface Props {
  data: ParsedTranscript;
}

const KIND_ORDER: EntryKind[] = [
  'user_message',
  'assistant_message',
  'tool_use',
  'tool_result',
  'system',
  'meta',
  'token_usage',
  'summary',
  'unknown',
];

export function GenericTranscriptStats({ data }: Props) {
  const counts: Partial<Record<EntryKind, number>> = {};
  const tools: Record<string, number> = {};
  for (const e of data.entries) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (e.kind === 'tool_use') tools[e.tool_name] = (tools[e.tool_name] ?? 0) + 1;
  }
  const total = data.entries.length;
  const { header } = data;

  return (
    <div
      className="border-b border-border bg-muted/10 px-3 py-2"
      data-testid="transcript-stats"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{data.worker_type}</span> · {formatNumber(total)} entries
        </span>
        <span>session: <span className="font-mono">{data.session_id || '<unknown>'}</span></span>
        {header.cwd && <span>cwd: <span className="font-mono">{header.cwd}</span></span>}
        {header.git?.branch && (
          <span>
            git: <span className="font-mono">{header.git.branch}</span>
            {header.git.commit_hash && <span className="ml-1">@{header.git.commit_hash.slice(0, 7)}</span>}
          </span>
        )}
        {header.cli_version && <span>cli: {header.cli_version}</span>}
        {header.model_provider && <span>provider: {header.model_provider}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {KIND_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => (
          <span
            key={k}
            className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]"
          >
            {k}: {counts[k]}
          </span>
        ))}
      </div>
      {Object.keys(tools).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {Object.entries(tools)
            .sort(([, a], [, b]) => b - a)
            .map(([name, n]) => (
              <span
                key={name}
                className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px]"
              >
                {name}: {n}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
