/**
 * Perf hunt 2026-11-07 (C2): the closed activity modal re-rendered every second while idle,
 * because ``useElapsedMs`` subscribed to the 1 Hz clock before looking at its spec. Only a
 * running activity's elapsed moves, so only that one ticks.
 */
import { act, render } from '@testing-library/react';
import { useElapsedMs } from '@src/hooks/useActivity';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

function rendersOver5s(spec: Parameters<typeof useElapsedMs>[0]): number {
  vi.useFakeTimers();
  let renders = 0;
  function Probe() {
    renders++;
    useElapsedMs(spec);
    return null;
  }
  render(<Probe />);
  act(() => vi.advanceTimersByTime(5_000));
  return renders;
}

describe('useElapsedMs', () => {
  it('ticks only for a running activity', () => {
    const started_at = new Date().toISOString();
    expect(rendersOver5s(null)).toBe(1);
    expect(rendersOver5s({ started_at, finished_at: started_at } as never)).toBe(1);
    expect(rendersOver5s({ started_at } as never)).toBeGreaterThan(1);
  });
});
