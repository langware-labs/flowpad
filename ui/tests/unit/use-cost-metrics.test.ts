import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLastMonthKeys, getLastWeekKeys, getTodayKey } from '@src/components/cost-dashboard/constants';
import { getDisplayValue, getSparklineData, useCostMetrics } from '@src/components/cost-dashboard/use-cost-metrics';
import type { CostOverview } from '@sdk';

const { mockUseCostOverview } = vi.hoisted(() => ({
  mockUseCostOverview: vi.fn(),
}));

vi.mock('@src/hooks/use-cost-overview', () => ({
  useCostOverview: (...args: unknown[]) => mockUseCostOverview(...args),
}));

function makeWindow(cost: number, tokens: number = 0, sessions: number = 0) {
  return {
    total_cost_usd: cost,
    total_tokens: tokens,
    total_input_tokens: 0,
    total_output_tokens: 0,
    cache_savings_usd: 0,
    session_count: sessions,
  };
}

describe('use-cost-metrics cohorts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-14T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses previous full calendar week/month and excludes current partial periods', () => {
    const by_day: Record<string, ReturnType<typeof makeWindow>> = {};
    const todayKey = getTodayKey();
    const lastWeekKeys = getLastWeekKeys();
    const lastMonthKeys = getLastMonthKeys();

    by_day[todayKey] = makeWindow(100, 1000, 1);

    for (const key of lastWeekKeys) {
      by_day[key] = makeWindow(2, 20, 1);
    }
    for (const key of lastMonthKeys) {
      by_day[key] = makeWindow(1, 10, 1);
    }

    // Current partial week (Mon-Fri before "today" on 2026-02-14) should not affect week/month.
    for (const key of ['2026-02-09', '2026-02-10', '2026-02-11', '2026-02-12', '2026-02-13']) {
      by_day[key] = makeWindow(9, 90, 1);
    }

    const data = {
      session_count: 43,
      totals: makeWindow(190, 1900, 43),
      by_day,
      by_week: {},
      by_month: {},
    } as unknown as CostOverview;

    expect(lastWeekKeys).toEqual([
      '2026-02-02',
      '2026-02-03',
      '2026-02-04',
      '2026-02-05',
      '2026-02-06',
      '2026-02-07',
      '2026-02-08',
    ]);
    expect(lastMonthKeys[0]).toBe('2026-01-01');
    expect(lastMonthKeys[lastMonthKeys.length - 1]).toBe('2026-01-31');
    expect(lastMonthKeys).toHaveLength(31);

    expect(getDisplayValue(data, 'today', 'totalCost')).toBe(100);
    expect(getDisplayValue(data, 'thisWeek', 'totalCost')).toBe(14);
    expect(getDisplayValue(data, 'thisMonth', 'totalCost')).toBe(31);
    expect(getDisplayValue(data, 'allTime', 'totalCost')).toBe(190);
  });

  it('builds week/month sparklines from full previous calendar periods', () => {
    const by_day: Record<string, ReturnType<typeof makeWindow>> = {};
    const todayKey = getTodayKey();
    const lastWeekKeys = getLastWeekKeys();
    const lastMonthKeys = getLastMonthKeys();

    by_day[todayKey] = makeWindow(100, 1000, 1);

    for (const key of lastWeekKeys) {
      by_day[key] = makeWindow(2, 20, 1);
    }
    for (const key of lastMonthKeys) {
      by_day[key] = makeWindow(1, 10, 1);
    }

    const data = {
      session_count: 39,
      totals: makeWindow(145, 1450, 39),
      by_day,
      by_week: {},
      by_month: {},
    } as unknown as CostOverview;

    const weekSparkline = getSparklineData(data, 'thisWeek', 'totalCost');
    expect(weekSparkline).toHaveLength(7);
    expect(weekSparkline[0].value).toBe(2);
    expect(weekSparkline[weekSparkline.length - 1].value).toBe(2);

    const monthSparkline = getSparklineData(data, 'thisMonth', 'totalCost');
    expect(monthSparkline).toHaveLength(lastMonthKeys.length);
    expect(monthSparkline[0].value).toBe(1);
    expect(monthSparkline[monthSparkline.length - 1].value).toBe(1);

    const todaySparkline = getSparklineData(data, 'today', 'totalCost');
    expect(todaySparkline[todaySparkline.length - 1].value).toBe(100);
  });

  it('requests full history for cohort calculations', () => {
    mockUseCostOverview.mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderHook(() => useCostMetrics());

    expect(mockUseCostOverview).toHaveBeenCalledWith({ sessionLimit: 100, autoFetch: false });
  });
});
