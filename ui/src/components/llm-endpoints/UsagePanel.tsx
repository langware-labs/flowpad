/**
 * An endpoint's usage: cohort tabs, metric tiles, a chart over the cohort's
 * buckets, and (for admins) the by-child / by-model breakdown with drill-down.
 *
 * Reuses the cost dashboard's cohort tabs and tile styling so the two screens
 * read as one; the metrics are the ledger's, not the local session's.
 */
import type { LLMEndpoint, LLMUsageBy, LLMUsageCounters } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, DollarSign, Repeat, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { TimeCohortTabs } from '@src/components/cost-dashboard/TimeCohortTabs';
import { formatValue, type TimeCohort, type ValueFormat } from '@src/components/cost-dashboard/constants';

import { UsageByChildTable } from './UsageByChildTable';
import { canConfigure } from './endpoint-catalog';
import { useLlmEndpointUsage } from './use-llm-endpoints';
import { ZERO_COUNTERS, cohortRange, formatUsd, toChartPoints, type ChartPoint } from './usage-math';

type Metric = {
  id: keyof Pick<
    LLMUsageCounters,
    'cost_usd' | 'total_tokens' | 'input_tokens' | 'output_tokens' | 'requests' | 'errors' | 'fallbacks'
  >;
  label: string;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  chartColor: string;
  format: ValueFormat;
};

function Tile({
  metric,
  value,
  selected,
  onClick,
}: {
  metric: Metric;
  value: number;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = metric.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`usage-tile-${metric.id}`}
      className={`flex w-full items-center gap-3 rounded-lg border p-2.5 text-start transition-all ${
        selected ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border hover:bg-muted/50'
      }`}
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${metric.bgColor}`}>
        <Icon className={`h-4 w-4 ${metric.color}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">
          {metric.format === 'currency' ? formatUsd(value) : formatValue(value, metric.format)}
        </div>
        <div className="text-xs text-muted-foreground">{metric.label}</div>
      </div>
    </button>
  );
}

export interface UsagePanelProps {
  endpointId: string;
  endpoint: LLMEndpoint | null;
  all: readonly LLMEndpoint[];
}

export function UsagePanel({ endpointId, endpoint, all }: UsagePanelProps) {
  const { t } = useLingui();
  const [cohort, setCohort] = useState<TimeCohort>('today');
  const [selected, setSelected] = useState<Metric['id']>('cost_usd');
  const [by, setBy] = useState<LLMUsageBy>('child');
  const isAdmin = canConfigure(endpoint);

  const range = useMemo(() => cohortRange(cohort), [cohort]);
  const query = useMemo(
    () => ({ from: range.from, to: range.to, granularity: range.granularity, ...(isAdmin ? { by } : {}) }),
    [range, isAdmin, by],
  );
  const { data, isLoading, error } = useLlmEndpointUsage(endpointId, query);
  const totals = data?.totals ?? ZERO_COUNTERS;
  const points = useMemo<ChartPoint[]>(() => toChartPoints(data?.series ?? [], range), [data, range]);

  const metrics: Metric[] = [
    {
      id: 'cost_usd',
      label: t`Cost`,
      icon: DollarSign,
      color: 'text-green-500',
      bgColor: 'bg-green-500/10',
      chartColor: '#22c55e',
      format: 'currency',
    },
    {
      id: 'total_tokens',
      label: t`Tokens`,
      icon: Zap,
      color: 'text-purple-500',
      bgColor: 'bg-purple-500/10',
      chartColor: '#a855f7',
      format: 'tokens',
    },
    {
      id: 'input_tokens',
      label: t`Input tokens`,
      icon: ArrowDownToLine,
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/10',
      chartColor: '#3b82f6',
      format: 'tokens',
    },
    {
      id: 'output_tokens',
      label: t`Output tokens`,
      icon: ArrowUpFromLine,
      color: 'text-cyan-500',
      bgColor: 'bg-cyan-500/10',
      chartColor: '#06b6d4',
      format: 'tokens',
    },
    {
      id: 'requests',
      label: t`Requests`,
      icon: Activity,
      color: 'text-orange-500',
      bgColor: 'bg-orange-500/10',
      chartColor: '#f97316',
      format: 'number',
    },
    {
      id: 'errors',
      label: t`Errors`,
      icon: AlertTriangle,
      color: 'text-red-500',
      bgColor: 'bg-red-500/10',
      chartColor: '#ef4444',
      format: 'number',
    },
    {
      id: 'fallbacks',
      label: t`Fallbacks`,
      icon: Repeat,
      color: 'text-amber-500',
      bgColor: 'bg-amber-500/10',
      chartColor: '#f59e0b',
      format: 'number',
    },
  ];
  const active = metrics.find((m) => m.id === selected) ?? metrics[0];
  const useBars = active.id === 'requests' || active.id === 'errors' || active.id === 'fallbacks';

  return (
    <div className="space-y-4" data-testid="usage-panel">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-64">
          <TimeCohortTabs selected={cohort} onSelect={setCohort} />
        </div>
        {isAdmin && (
          <div className="flex rounded-lg bg-muted p-0.5 text-xs">
            {(['child', 'model'] as const).map((b) => (
              <button
                key={b}
                type="button"
                data-testid={`usage-by-${b}`}
                onClick={() => setBy(b)}
                className={`rounded-md px-2 py-1 font-medium ${by === b ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
              >
                {b === 'child' ? t`By child` : t`By model`}
              </button>
            ))}
          </div>
        )}
        {(totals.estimated_requests > 0 || totals.unpriced_requests > 0) && (
          <span className="text-xs text-muted-foreground" data-testid="usage-caveat">
            {t`${totals.estimated_requests} estimated · ${totals.unpriced_requests} unpriced`}
          </span>
        )}
        {error && (
          <span className="text-xs text-destructive">
            <Trans>Could not load usage.</Trans>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        {metrics.map((m) => (
          <Tile
            key={m.id}
            metric={m}
            value={totals[m.id]}
            selected={m.id === active.id}
            onClick={() => setSelected(m.id)}
          />
        ))}
      </div>

      <div className="h-56 w-full rounded-lg border p-2" data-testid="usage-chart">
        {isLoading && points.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">…</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {useBars ? (
              <BarChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={16} />
                <YAxis tick={{ fontSize: 10 }} width={40} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey={active.id} fill={active.chartColor} isAnimationActive={false} />
              </BarChart>
            ) : (
              <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={16} />
                <YAxis tick={{ fontSize: 10 }} width={48} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey={active.id}
                  stroke={active.chartColor}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {isAdmin && data?.breakdown && <UsageByChildTable by={by} breakdown={data.breakdown} all={all} />}
    </div>
  );
}
