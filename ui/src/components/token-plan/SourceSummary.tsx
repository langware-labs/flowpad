/**
 * The token plan's centre: ONE layout whatever is selected -- the budget, consumption over a window,
 * and the breakdown underneath. With nothing selected it is the sum of every source; with a row
 * selected it is that row, which already includes everything allocated from it (the hub books a call
 * against every hop of its path, so a source's own usage IS its subtree's).
 */
import type { LLMEndpoint, LLMUsageReport } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueries } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';

import { TimeCohortTabs } from '@src/components/cost-dashboard/TimeCohortTabs';
import { formatValue, type TimeCohort } from '@src/components/cost-dashboard/constants';
import { usageQueryOptions } from '@src/components/llm-endpoints/use-llm-endpoints';
import {
  COST_CHART_COLOR,
  ZERO_COUNTERS,
  addCounters,
  cohortRange,
  formatUsd,
  toChartPoints,
} from '@src/components/llm-endpoints/usage-math';

import { costLeft } from './source-tree';

export interface SummaryItem {
  endpoint: LLMEndpoint;
  /** Shown in the breakdown. */
  label: string;
}

export function SourceSummary({
  title,
  subject,
  breakdown,
  breakdownTitle,
  onOpen,
  subtitle,
  afterBudget,
}: {
  title: string;
  /** What the budget and consumption are of: one selected row, or every source. */
  subject: readonly LLMEndpoint[];
  /** The rows listed underneath (the selection's allocations, or the sources). */
  breakdown: readonly SummaryItem[];
  breakdownTitle: string;
  onOpen: (endpoint: LLMEndpoint) => void;
  /** The line under the headline: the window the limit is judged over and when it resets. */
  subtitle?: string | null;
  /** Rendered between the budget and consumption (the selected row's "Funded through"). */
  afterBudget?: ReactNode;
}) {
  const { t } = useLingui();
  const [cohort, setCohort] = useState<TimeCohort>('today');
  const range = useMemo(() => cohortRange(cohort), [cohort]);
  const ids = useMemo(() => {
    const all = new Map<string, LLMEndpoint>();
    for (const e of [...subject, ...breakdown.map((b) => b.endpoint)]) all.set(e.id, e);
    return [...all.keys()];
  }, [subject, breakdown]);
  const results = useQueries({ queries: ids.map((id) => usageQueryOptions(id, range)) });
  const usage = new Map<string, LLMUsageReport | undefined>(ids.map((id, i) => [id, results[i]?.data]));

  const totals = subject.reduce((acc, e) => addCounters(acc, usage.get(e.id)?.totals ?? {}), { ...ZERO_COUNTERS });
  const points = toChartPoints(
    subject.flatMap((e) => usage.get(e.id)?.series ?? []),
    range,
  );

  const caps = subject.map(costLeft).filter((c): c is NonNullable<typeof c> => !!c);
  const budget = caps.length
    ? { left: caps.reduce((s, c) => s + Math.max(0, c.remaining), 0), limit: caps.reduce((s, c) => s + c.limit, 0) }
    : null;
  const uncapped = subject.length - caps.length;

  const tiles = [
    { id: 'cost', label: t`Cost`, value: formatUsd(totals.cost_usd) },
    { id: 'tokens', label: t`Tokens`, value: formatValue(totals.total_tokens, 'tokens') },
    { id: 'requests', label: t`Requests`, value: formatValue(totals.requests, 'number') },
  ];

  return (
    <div className="space-y-6" data-testid="source-summary">
      <section className="rounded-xl border bg-card p-5" data-testid="summary-budget">
        <div className="text-xs text-muted-foreground" data-testid="summary-title">
          {title}
        </div>
        <div className="mt-1 text-2xl font-semibold" data-testid="budget-headline">
          {budget ? (
            <Trans>
              {formatUsd(budget.left)} left of {formatUsd(budget.limit)}
            </Trans>
          ) : (
            <Trans>No limit</Trans>
          )}
        </div>
        {budget && subtitle && (
          <div className="mt-1 text-xs text-muted-foreground" data-testid="budget-subtitle">
            {subtitle}
          </div>
        )}
        {budget && (
          <div className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-primary/20">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.min(100, ((budget.limit - budget.left) / (budget.limit || 1)) * 100)}%` }}
            />
          </div>
        )}
        {budget && uncapped > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans>Plus {uncapped} without a limit.</Trans>
          </p>
        )}
      </section>

      {afterBudget}

      <section className="space-y-3" data-testid="consumption-panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            <Trans>Consumption</Trans>
          </h2>
          <div className="w-64">
            <TimeCohortTabs selected={cohort} onSelect={setCohort} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {tiles.map((tile) => (
            <div key={tile.id} className="rounded-lg border p-3" data-testid={`consumption-${tile.id}`}>
              <div className="text-lg font-semibold">{tile.value}</div>
              <div className="text-xs text-muted-foreground">{tile.label}</div>
            </div>
          ))}
        </div>
        <div className="h-28 w-full rounded-lg border p-2" data-testid="consumption-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={24} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v?: number) => formatUsd(v ?? 0)} />
              <Bar dataKey="cost_usd" fill={COST_CHART_COLOR} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="space-y-2" data-testid="summary-breakdown">
        <h2 className="text-sm font-medium">{breakdownTitle}</h2>
        <div className="rounded-lg border">
          {breakdown.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              <Trans>Nothing allocated from this source yet.</Trans>
            </p>
          ) : (
            breakdown.map(({ endpoint: e, label }) => {
              const left = costLeft(e);
              const spent = usage.get(e.id)?.totals?.cost_usd ?? 0;
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onOpen(e)}
                  className="flex w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-accent/40"
                  data-testid={`breakdown-${e.id}`}
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                    <Trans>spent {formatUsd(spent)}</Trans>
                  </span>
                  <span className="w-28 whitespace-nowrap text-right tabular-nums">
                    {left ? (
                      <>
                        {formatUsd(Math.max(0, left.remaining))}
                        <span className="text-muted-foreground"> / {formatUsd(left.limit)}</span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        <Trans>no limit</Trans>
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
