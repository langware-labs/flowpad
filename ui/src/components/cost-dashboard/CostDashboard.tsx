/**
 * CostDashboard - Main container for the Usage & Cost mini dashboard.
 *
 * Displays cost metrics with time cohort navigation and sparkline charts.
 */

import { RefreshCw } from 'lucide-react';
import { FusionSpinner } from '@src/components/icons/FusionSpinner';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { CostMetricCard } from './CostMetricCard';
import { TimeCohortTabs } from './TimeCohortTabs';
import { useCostMetrics } from './use-cost-metrics';

export function CostDashboard() {
  const { t } = useLingui();
  const { data, isLoading, error, refetch, selectedTimeCohort, setSelectedTimeCohort, categoryMetrics, sessionCount } =
    useCostMetrics();
  const [selectedCategory, setSelectedCategory] = useState<string>('totalCost');

  if (error) {
    return (
      <div className="flex h-full flex-col rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border p-3">
          <h3 className="text-sm font-semibold"><Trans>Usage & Costs</Trans></h3>
        </div>
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          <div>
            <p className="text-red-500">{error}</p>
            <button onClick={() => void refetch()} className="mt-2 text-xs text-primary hover:underline">
              <Trans>Try again</Trans>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold"><Trans>Usage & Costs</Trans></h3>
          {sessionCount > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Trans>{sessionCount} sessions</Trans>
            </span>
          )}
        </div>
        <button
          onClick={() => void refetch()}
          disabled={isLoading}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title={t`Refresh`}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Time Cohort Tabs */}
      <div className="border-b border-border p-3">
        <TimeCohortTabs selected={selectedTimeCohort} onSelect={setSelectedTimeCohort} />
      </div>

      {/* Metrics List */}
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {isLoading && !data ? (
          <div className="flex h-full items-center justify-center">
            <FusionSpinner size="md" />
          </div>
        ) : (
          categoryMetrics.map(({ category, value, sparklineData }) => (
            <CostMetricCard
              key={category.id}
              category={category}
              value={value}
              sparklineData={sparklineData}
              isSelected={selectedCategory === category.id}
              onClick={() => setSelectedCategory(category.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
