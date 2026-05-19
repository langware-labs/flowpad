import type { StepHistory } from '../../data/types';

interface PerRunBreakdownProps {
  history?: StepHistory;
}

function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function fmt$(usd?: number): string {
  if (usd === undefined || usd === null || usd <= 0) return '—';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/**
 * Expert-mode-only: this step across every loaded run.
 */
export function PerRunBreakdown({ history }: PerRunBreakdownProps) {
  if (!history || history.points.length === 0) return null;
  return (
    <details
      data-testid="expert-section-per-run-breakdown"
      open
      className="rounded-md border bg-muted/30"
    >
      <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Per-run breakdown ({history.points.length})
      </summary>
      <div className="border-t">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-1.5 font-medium">Run</th>
              <th className="px-3 py-1.5 font-medium">Status</th>
              <th className="px-3 py-1.5 font-medium">Time</th>
              <th className="px-3 py-1.5 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {history.points.map((p) => (
              <tr key={p.processId} className="border-t border-border/60">
                <td className="px-3 py-1.5 font-mono text-[10px]">{p.processId.slice(0, 8)}</td>
                <td className="px-3 py-1.5">{p.status}</td>
                <td className="px-3 py-1.5">{fmtMs(p.duration_ms)}</td>
                <td className="px-3 py-1.5">{fmt$(p.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
