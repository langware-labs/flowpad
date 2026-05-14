import type { StepViewModel } from '../../data/types';

interface TranscriptSliceProps {
  step: StepViewModel;
}

/**
 * Expert-mode-only: tool calls extracted by the analyzer for this step.
 * Phase 6 ships the read-only view; jumping to the raw transcript is a
 * Phase 8+ follow-up.
 */
export function TranscriptSlice({ step }: TranscriptSliceProps) {
  const calls = step.tool_calls ?? [];
  if (calls.length === 0) return null;
  return (
    <details
      data-testid="expert-section-transcript-slice"
      className="rounded-md border bg-muted/30"
    >
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Transcript ({calls.length} tool calls)
      </summary>
      <ol className="space-y-1 border-t px-3 py-2 text-xs">
        {calls.map((c, i) => (
          <li key={i} className="leading-relaxed">
            <span className="font-mono text-[10px] text-muted-foreground">{i + 1}.</span>{' '}
            <span className="font-mono">{c.name}</span>
            {c.result_summary && (
              <span className="ml-1 text-muted-foreground">— {c.result_summary}</span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
