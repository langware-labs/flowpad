/**
 * Runs, newest first, grouped by day: status · time · automation · why · outcome.
 * Shared by the Runs place (every automation) and an automation's Runs tab.
 */
import { Trans } from '@lingui/react/macro';
import type { AutomationRun } from '@sdk';
import { cn } from '@src/lib/utils';
import { useAutomationWords } from './automation-words';
import { RunStatusDot } from './RunStatusPill';

export interface RunsListProps {
  runs: AutomationRun[];
  selectedId?: string | null;
  onSelect: (run: AutomationRun) => void;
  /** Hide the automation's name — inside one automation's own tab. */
  hideName?: boolean;
  emptyText?: React.ReactNode;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toDateString();
}

export function RunsList({ runs, selectedId, onSelect, hideName, emptyText }: RunsListProps) {
  const words = useAutomationWords();
  if (runs.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="runs-empty">
        {emptyText ?? <Trans>No runs yet.</Trans>}
      </p>
    );
  }
  const days: Array<{ key: string; label: string; runs: AutomationRun[] }> = [];
  for (const run of runs) {
    const key = dayKey(run.ts);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      const label = words.at(run.ts).replace(/\s*\d{1,2}:\d{2}.*$/, '');
      day = { key, label, runs: [] };
      days.push(day);
    }
    day.runs.push(run);
  }
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div data-testid="runs-list">
      {days.map((day) => (
        <section key={day.key}>
          <h4 className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {day.label}
          </h4>
          {day.runs.map((run) => (
            <button
              key={run.id}
              type="button"
              data-testid={`run-row-${run.id}`}
              data-status={run.status}
              onClick={() => onSelect(run)}
              aria-current={selectedId === run.id}
              className={cn(
                'grid w-full grid-cols-[auto_3.5rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-2 text-left text-sm hover:bg-accent/50',
                selectedId === run.id && 'bg-accent',
                run.status === 'failed' && 'border-l-2 border-l-red-500/70',
              )}
            >
              <RunStatusDot status={run.status} />
              <span className="text-xs tabular-nums text-muted-foreground">{clock(run.ts)}</span>
              <span className="min-w-0">
                {!hideName && <span className="block truncate font-medium">{run.automation_name}</span>}
                <span className="block truncate text-xs text-muted-foreground">
                  {words.why(run)}
                  {run.is_test && (
                    <span className="ml-1.5 rounded border border-border px-1 text-[10px]">
                      <Trans>test</Trans>
                    </span>
                  )}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {run.status === 'failed' ? (
                  <span className="text-foreground">{words.status('failed')}</span>
                ) : run.status === 'skipped' ? (
                  words.status('skipped')
                ) : (
                  words.duration(run.duration_ms) || words.status(run.status)
                )}
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
