import { i18n } from '@lingui/core';
/**
 * CostMetricCard - Displays a single cost metric with icon, value, and sparkline.
 */

import { formatValue, type CostCategory } from './constants';
import { CostSparkline } from './CostSparkline';

interface SparklineDataPoint {
  value: number;
}

interface CostMetricCardProps {
  category: CostCategory;
  value: number;
  sparklineData: SparklineDataPoint[];
  isSelected: boolean;
  onClick: () => void;
}

export function CostMetricCard({ category, value, sparklineData, isSelected, onClick }: CostMetricCardProps) {
  const Icon = category.icon;

  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg border p-2.5 text-start transition-all ${
        isSelected ? 'border-primary bg-primary/5' : 'border-transparent hover:border-border hover:bg-muted/50'
      }`}
    >
      {/* Icon */}
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${category.bgColor}`}>
        <Icon className={`h-4 w-4 ${category.color}`} />
      </div>

      {/* Value and Label */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold">{formatValue(value, category.format)}</span>
        </div>
        <span className="text-xs text-muted-foreground">{i18n._(category.label)}</span>
      </div>

      {/* Sparkline */}
      <div className="shrink-0">
        <CostSparkline data={sparklineData} color={category.chartColor} />
      </div>
    </button>
  );
}
