/**
 * A local deployment made from an agent's Deploy places that agent as main: the agent preset (`?deploy_main_agent`)
 * is cleared when New deployment closes, and the "Run on this computer" switch behind it must still know it.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useCameFromAgent } from '@src/components/project-deployments/use-came-from-agent';

describe('useCameFromAgent', () => {
  it('keeps the agent after the dialog clears the preset', () => {
    const { result, rerender } = renderHook(({ preset }) => useCameFromAgent(preset), {
      initialProps: { preset: 'a1' as string | null },
    });
    expect(result.current).toBe('a1');
    rerender({ preset: null }); // the New deployment dialog closed
    expect(result.current).toBe('a1');
  });

  it('follows a new agent preset', () => {
    const { result, rerender } = renderHook(({ preset }) => useCameFromAgent(preset), {
      initialProps: { preset: 'a1' as string | null },
    });
    rerender({ preset: 'a2' });
    expect(result.current).toBe('a2');
  });

  it('is none when the page was not opened from an agent', () => {
    const { result } = renderHook(() => useCameFromAgent(null));
    expect(result.current).toBeNull();
  });
});
