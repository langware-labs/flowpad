import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useInputHistory } from '@src/hooks/use-input-history';

describe('useInputHistory seed/select/browsing', () => {
  it('seeds from transcript entries and is idempotent', () => {
    const { result } = renderHook(() => useInputHistory());
    act(() => result.current.seed(['a', 'b', 'b', ' ', 'c']));
    expect(result.current.entries).toEqual(['a', 'b', 'c']);

    const before = result.current;
    act(() => result.current.seed(['a', 'b', 'c']));
    // Unchanged entries → no state churn (same identity snapshot).
    expect(result.current).toBe(before);
  });

  it('one ArrowUp = last prompt; index is reactive for the list UI', () => {
    const { result } = renderHook(() => useInputHistory());
    act(() => result.current.seed(['first', 'second']));
    let text = '';
    act(() => { text = result.current.navigateUp('draft'); });
    expect(text).toBe('second');
    expect(result.current.index).toBe(1);
    expect(result.current.browsing).toBe(true);
    act(() => { text = result.current.navigateUp(text); });
    expect(text).toBe('first');
    expect(result.current.index).toBe(0);
    // Down past the newest restores the stashed draft and exits browsing.
    act(() => { text = result.current.navigateDown(text); });
    expect(text).toBe('second');
    act(() => { text = result.current.navigateDown(text); });
    expect(text).toBe('draft');
    expect(result.current.browsing).toBe(false);
  });

  it('select jumps browsing; exitBrowsing restores the draft', () => {
    const { result } = renderHook(() => useInputHistory());
    act(() => result.current.seed(['one', 'two', 'three']));
    act(() => { result.current.navigateUp('my draft'); });
    let picked = '';
    act(() => { picked = result.current.select(0); });
    expect(picked).toBe('one');
    expect(result.current.index).toBe(0);
    let draft = '';
    act(() => { draft = result.current.exitBrowsing(); });
    expect(draft).toBe('my draft');
    expect(result.current.browsing).toBe(false);
  });

  it('reseeding with changed entries resets browsing', () => {
    const { result } = renderHook(() => useInputHistory());
    act(() => result.current.seed(['a']));
    act(() => { result.current.navigateUp(''); });
    expect(result.current.browsing).toBe(true);
    act(() => result.current.seed(['a', 'b']));
    expect(result.current.browsing).toBe(false);
    expect(result.current.entries).toEqual(['a', 'b']);
  });
});
