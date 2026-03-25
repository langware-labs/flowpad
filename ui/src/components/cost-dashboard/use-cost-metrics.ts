/**
 * Shared hook for cost metrics data fetching and computation.
 *
 * Used by both CostDashboard (full panel) and UsageBar (condensed bar).
 */

import { useCostOverview } from '@src/hooks/use-cost-overview';
import type { CostOverview, CostTimeWindow } from '@sdk';
import { useEffect, useMemo, useState } from 'react';
import {
  COST_CATEGORIES,
  getLastMonthKeys,
  getLastNDaysKeys,
  getLastWeekKeys,
  getTodayKey,
  type CostCategory,
  type TimeCohort,
} from './constants';

export interface SparklineDataPoint {
  value: number;
}

export interface CategoryMetric {
  category: CostCategory;
  value: number;
  sparklineData: SparklineDataPoint[];
}

/**
 * Extract metric value from CostTimeWindow or totals based on category ID.
 */
export function extractMetricValue(
  source: CostTimeWindow | CostOverview['totals'] | null | undefined,
  categoryId: string,
): number {
  if (!source) return 0;

  switch (categoryId) {
    case 'totalCost':
      return 'total_cost_usd' in source ? source.total_cost_usd : 0;
    case 'totalTokens':
      return 'total_tokens' in source ? source.total_tokens : 0;
    case 'inputTokens':
      return 'total_input_tokens' in source ? source.total_input_tokens : 0;
    case 'outputTokens':
      return 'total_output_tokens' in source ? source.total_output_tokens : 0;
    case 'cacheSavings':
      return 'cache_savings_usd' in source ? source.cache_savings_usd : 0;
    case 'sessions':
      return 'session_count' in source ? source.session_count : 0;
    default:
      return 0;
  }
}

/**
 * Get display value for a time cohort and category.
 */
export function getDisplayValue(data: CostOverview | null, timeCohort: TimeCohort, categoryId: string): number {
  if (!data) return 0;

  switch (timeCohort) {
    case 'today': {
      const todayKey = getTodayKey();
      const todayData = data.by_day?.[todayKey];
      return extractMetricValue(todayData, categoryId);
    }
    case 'thisWeek': {
      // Previous full calendar week (Mon-Sun), excludes current partial week.
      const dayKeys = getLastWeekKeys();
      return dayKeys.reduce((sum, key) => {
        const dayData = data.by_day?.[key];
        return sum + extractMetricValue(dayData, categoryId);
      }, 0);
    }
    case 'thisMonth': {
      // Previous full calendar month, excludes current partial month.
      const dayKeys = getLastMonthKeys();
      return dayKeys.reduce((sum, key) => {
        const dayData = data.by_day?.[key];
        return sum + extractMetricValue(dayData, categoryId);
      }, 0);
    }
    case 'allTime':
    default:
      if (categoryId === 'sessions') {
        return data.session_count || 0;
      }
      return extractMetricValue(data.totals, categoryId);
  }
}

/**
 * Get sparkline data for a time cohort and category.
 */
export function getSparklineData(
  data: CostOverview | null,
  timeCohort: TimeCohort,
  categoryId: string,
): SparklineDataPoint[] {
  if (!data) return [];

  switch (timeCohort) {
    case 'today': {
      if (!data.by_day) return [];
      // Keep today's trend inclusive for the "Today" cohort.
      const dayKeys = getLastNDaysKeys(7).reverse();
      return dayKeys.map((key) => ({
        value: extractMetricValue(data.by_day[key], categoryId),
      }));
    }
    case 'thisWeek': {
      if (!data.by_day) return [];
      // Previous full calendar week (Mon-Sun), already oldest -> newest.
      const dayKeys = getLastWeekKeys();
      return dayKeys.map((key) => ({
        value: extractMetricValue(data.by_day[key], categoryId),
      }));
    }
    case 'thisMonth': {
      if (!data.by_day) return [];
      // Previous full calendar month, already oldest -> newest.
      const dayKeys = getLastMonthKeys();
      return dayKeys.map((key) => ({
        value: extractMetricValue(data.by_day[key], categoryId),
      }));
    }
    case 'allTime':
    default: {
      if (!data.by_month) return [];
      const monthEntries = Object.entries(data.by_month).sort(([a], [b]) => a.localeCompare(b));
      return monthEntries.map(([, monthData]) => ({
        value: extractMetricValue(monthData, categoryId),
      }));
    }
  }
}

/**
 * Shared hook that provides cost metrics data and time cohort state.
 *
 * Both CostDashboard and UsageBar mount this independently —
 * useCostOverview has module-level caching so no duplicate API calls.
 */
export function useCostMetrics() {
  // Use full history so time cohorts (week/month/all) can diverge correctly.
  // Defer cost fetch so it doesn't compete with critical page-load requests.
  const { data, isLoading, error, refetch } = useCostOverview({ sessionLimit: 100, autoFetch: false });

  // Fire the fetch 3s after mount — well after bootstrap and other critical requests.
  useEffect(() => {
    const timer = setTimeout(() => void refetch(), 3000);
    return () => clearTimeout(timer);
  }, [refetch]);

  const [selectedTimeCohort, setSelectedTimeCohort] = useState<TimeCohort>('thisWeek');

  const categoryMetrics = useMemo<CategoryMetric[]>(() => {
    return COST_CATEGORIES.map((category) => ({
      category,
      value: getDisplayValue(data, selectedTimeCohort, category.id),
      sparklineData: getSparklineData(data, selectedTimeCohort, category.id),
    }));
  }, [data, selectedTimeCohort]);

  const sessionCount = data?.session_count || 0;

  return {
    data,
    isLoading,
    error,
    refetch,
    selectedTimeCohort,
    setSelectedTimeCohort,
    categoryMetrics,
    sessionCount,
  };
}
