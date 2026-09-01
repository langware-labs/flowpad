/**
 * What the scope burned: cohort tabs → cost / tokens / requests from the
 * hub's precomputed `totals`, plus a 30-day daily bar sparkline of `series`.
 */
import type { TokenPlanScope } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';

import { TimeCohortTabs } from '@src/components/cost-dashboard/TimeCohortTabs';
import { formatValue, type TimeCohort } from '@src/components/cost-dashboard/constants';
import { COST_CHART_COLOR, formatUsd } from '@src/components/llm-endpoints/usage-math';

const COHORT_TO_TOTALS: Record<TimeCohort, keyof TokenPlanScope['totals']> = {
  today: 'today',
  thisWeek: 'week',
  thisMonth: 'month',
  allTime: 'all',
};

export function ConsumptionPanel({ scope }: { scope: TokenPlanScope }) {
  const { t } = useLingui();
  const [cohort, setCohort] = useState<TimeCohort>('today');
  const totals = scope.totals[COHORT_TO_TOTALS[cohort]];
  // Both feed recharts, which re-renders the whole chart on a new array
  // identity — rebuilding 30 points on every keystroke elsewhere is wasted work.
  const points = useMemo(() => scope.series.map((p) => ({ ...p, label: p.day.slice(5) })), [scope.series]);
  const tiles = useMemo(
    () => [
      { id: 'cost', label: t`Cost`, value: formatUsd(totals?.cost_usd ?? 0) },
      { id: 'tokens', label: t`Tokens`, value: formatValue(totals?.total_tokens ?? 0, 'tokens') },
      { id: 'requests', label: t`Requests`, value: formatValue(totals?.requests ?? 0, 'number') },
    ],
    [t, totals],
  );
  return (
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
      <div className="h-24 w-full rounded-lg border p-2" data-testid="consumption-chart">
        {points.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Trans>No usage in the last 30 days.</Trans>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={24} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v?: number) => formatUsd(v ?? 0)} />
              <Bar dataKey="cost_usd" fill={COST_CHART_COLOR} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
