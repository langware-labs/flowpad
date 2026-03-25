/**
 * UsageBar - Condensed horizontal cost/token summary bar.
 *
 * Displays total cost, total tokens, and a sparkline in a compact
 * two-row layout with time cohort tabs.
 */

import { FusionSpinner } from '@src/components/icons/FusionSpinner';
import { DollarSign, Zap } from 'lucide-react';
import { formatValue } from './constants';
import { CostSparkline } from './CostSparkline';
import { TimeCohortTabs } from './TimeCohortTabs';
import { useCostMetrics } from './use-cost-metrics';

export function UsageBar() {
  const { isLoading, error, selectedTimeCohort, setSelectedTimeCohort, categoryMetrics, data } = useCostMetrics();

  const totalCostMetric = categoryMetrics.find((m) => m.category.id === 'totalCost');
  const totalTokensMetric = categoryMetrics.find((m) => m.category.id === 'totalTokens');

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">Usage unavailable</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-1.5">
      {/* Row 1: Time cohort tabs (always rendered to preserve height) */}
      <div className="[&_button]:px-1.5 [&_button]:py-0.5 [&_button]:text-[10px]">
        <TimeCohortTabs selected={selectedTimeCohort} onSelect={setSelectedTimeCohort} />
      </div>

      {/* Row 2: Cost + Tokens + Sparkline (or loading spinner) */}
      {isLoading && !data ? (
        <div className="flex items-center text-xs">
          <FusionSpinner size="sm" />
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          {/* Total cost */}
          <div className="flex items-center gap-1">
            <DollarSign className="h-3 w-3 text-green-500" />
            <span className="font-medium">{formatValue(totalCostMetric?.value ?? 0, 'currency')}</span>
            <span className="text-muted-foreground">cost</span>
          </div>

          <div className="h-3 w-px bg-border" />

          {/* Total tokens */}
          <div className="flex items-center gap-1">
            <Zap className="h-3 w-3 text-purple-500" />
            <span className="font-medium">{formatValue(totalTokensMetric?.value ?? 0, 'tokens')}</span>
            <span className="text-muted-foreground">tokens</span>
          </div>

          <div className="h-3 w-px bg-border" />

          {/* Sparkline (total cost trend) */}
          {totalCostMetric && (
            <CostSparkline data={totalCostMetric.sparklineData} color={totalCostMetric.category.chartColor} />
          )}
        </div>
      )}
    </div>
  );
}
