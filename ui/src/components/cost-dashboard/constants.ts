/**
 * Category definitions for the Cost Dashboard.
 *
 * Each category defines a metric to display with its formatting and styling.
 */

import { Activity, ArrowDownToLine, ArrowUpFromLine, Database, DollarSign, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type TimeCohort = 'today' | 'thisWeek' | 'thisMonth' | 'allTime';
export type ValueFormat = 'currency' | 'tokens' | 'number';

export interface CostCategory {
  id: string;
  label: string;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  format: ValueFormat;
  chartColor: string;
}

/**
 * Categories to display in the cost dashboard.
 * Order matters - this is the display order.
 */
export const COST_CATEGORIES: CostCategory[] = [
  {
    id: 'totalCost',
    label: 'Total Cost',
    icon: DollarSign,
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
    format: 'currency',
    chartColor: '#22c55e',
  },
  {
    id: 'totalTokens',
    label: 'Total Tokens',
    icon: Zap,
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
    format: 'tokens',
    chartColor: '#a855f7',
  },
  {
    id: 'inputTokens',
    label: 'Input Tokens',
    icon: ArrowDownToLine,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    format: 'tokens',
    chartColor: '#3b82f6',
  },
  {
    id: 'outputTokens',
    label: 'Output Tokens',
    icon: ArrowUpFromLine,
    color: 'text-cyan-500',
    bgColor: 'bg-cyan-500/10',
    format: 'tokens',
    chartColor: '#06b6d4',
  },
  {
    id: 'cacheSavings',
    label: 'Cache Savings',
    icon: Database,
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-500/10',
    format: 'currency',
    chartColor: '#10b981',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: Activity,
    color: 'text-orange-500',
    bgColor: 'bg-orange-500/10',
    format: 'number',
    chartColor: '#f97316',
  },
];

/**
 * Time cohort definitions for filtering.
 */
export const TIME_COHORTS: { id: TimeCohort; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'thisWeek', label: 'Week' },
  { id: 'thisMonth', label: 'Month' },
  { id: 'allTime', label: 'All' },
];

/**
 * Format a value based on its type.
 */
export function formatValue(value: number, format: ValueFormat): string {
  if (value === 0) {
    if (format === 'currency') return '$0';
    return '0';
  }

  switch (format) {
    case 'currency':
      if (value < 0.01) return `$${value.toFixed(3)}`;
      if (value < 1) return `$${value.toFixed(2)}`;
      if (value < 100) return `$${value.toFixed(2)}`;
      return `$${Math.round(value)}`;

    case 'tokens':
      if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
      return value.toString();

    case 'number':
    default:
      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
      return value.toString();
  }
}

/**
 * Get today's date key in the format used by by_day (YYYY-MM-DD).
 */
export function getTodayKey(): string {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Get the last N days' keys.
 */
export function getLastNDaysKeys(n: number, offsetDays: number = 0): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i - offsetDays);
    keys.push(date.toISOString().split('T')[0]);
  }
  return keys;
}

/**
 * Get keys for the previous full calendar week (Mon-Sun) in UTC.
 * Returned in chronological order (oldest -> newest).
 */
export function getLastWeekKeys(): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (todayUtc.getUTCDay() + 6) % 7;

  const startOfCurrentWeek = new Date(todayUtc);
  startOfCurrentWeek.setUTCDate(startOfCurrentWeek.getUTCDate() - daysSinceMonday);

  const startOfLastWeek = new Date(startOfCurrentWeek);
  startOfLastWeek.setUTCDate(startOfLastWeek.getUTCDate() - 7);

  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfLastWeek);
    d.setUTCDate(startOfLastWeek.getUTCDate() + i);
    keys.push(d.toISOString().split('T')[0]);
  }
  return keys;
}

/**
 * Get keys for the previous full calendar month in UTC.
 * Returned in chronological order (oldest -> newest).
 */
export function getLastMonthKeys(): string[] {
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() - 1;

  if (month < 0) {
    month = 11;
    year -= 1;
  }

  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const keys: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, month, day));
    keys.push(d.toISOString().split('T')[0]);
  }
  return keys;
}
