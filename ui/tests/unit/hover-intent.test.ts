import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHoverIntent } from '@src/hooks/use-hover-intent';
import { useIdleAutoClose } from '@src/hooks/use-idle-auto-close';

const mouse = { pointerType: 'mouse' } as React.PointerEvent;
const touch = { pointerType: 'touch' } as React.PointerEvent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useHoverIntent', () => {
  const setup = () => renderHook(() => useHoverIntent({ openMs: 100, closeMs: 300 }));

  it('opens only after the dwell — a pointer sweeping past never opens it', () => {
    const { result } = setup();

    act(() => result.current.hoverProps.onPointerEnter(mouse));
    act(() => void vi.advanceTimersByTime(99));
    expect(result.current.open).toBe(false);

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(true);
  });

  it('leaving before the dwell cancels the open entirely', () => {
    const { result } = setup();

    act(() => result.current.hoverProps.onPointerEnter(mouse));
    act(() => void vi.advanceTimersByTime(50));
    act(() => result.current.hoverProps.onPointerLeave(mouse));
    act(() => void vi.advanceTimersByTime(1000));

    expect(result.current.open).toBe(false);
  });

  it('closes after the grace period', () => {
    const { result } = setup();
    act(() => result.current.set(true));

    act(() => result.current.hoverProps.onPointerLeave(mouse));
    act(() => void vi.advanceTimersByTime(299));
    expect(result.current.open).toBe(true);

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(false);
  });

  it('re-entering during the grace cancels the close — the rail→panel crossing', () => {
    // The case the whole shared-intent design exists for: leaving the rail
    // button fires leave, entering the panel fires enter, and the menu must not
    // flicker shut in between.
    const { result } = setup();
    act(() => result.current.set(true));

    act(() => result.current.hoverProps.onPointerLeave(mouse));
    act(() => void vi.advanceTimersByTime(200));
    act(() => result.current.hoverProps.onPointerEnter(mouse));
    act(() => void vi.advanceTimersByTime(1000));

    expect(result.current.open).toBe(true);
  });

  it('set() is immediate and beats a pending transition', () => {
    const { result } = setup();

    act(() => result.current.hoverProps.onPointerEnter(mouse));
    act(() => result.current.set(false));
    act(() => void vi.advanceTimersByTime(1000));

    // The pending open must not resurrect what the click just closed.
    expect(result.current.open).toBe(false);
  });

  it('ignores touch — a tap must not hover-open and click-toggle at once', () => {
    const { result } = setup();

    act(() => result.current.hoverProps.onPointerEnter(touch));
    act(() => void vi.advanceTimersByTime(1000));

    expect(result.current.open).toBe(false);
  });

  it('unmount clears a pending transition', () => {
    const { result, unmount } = setup();
    act(() => result.current.hoverProps.onPointerEnter(mouse));
    unmount();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });
});

describe('useIdleAutoClose', () => {
  it('fires onIdle after the idle window elapses', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleAutoClose(true, onIdle, 5000));
    expect(onIdle).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(4999));
    expect(onIdle).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('activity resets the timer', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleAutoClose(true, onIdle, 5000));
    act(() => void vi.advanceTimersByTime(4000));
    act(() => void window.dispatchEvent(new Event('pointermove')));
    act(() => void vi.advanceTimersByTime(4000)); // 8s total, but 4s since reset
    expect(onIdle).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1000));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('does not arm when inactive', () => {
    const onIdle = vi.fn();
    renderHook(() => useIdleAutoClose(false, onIdle, 5000));
    act(() => void vi.advanceTimersByTime(10000));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('never arms with idleMs=null — the hover-menu opt-out', () => {
    // Regression guard for the `Infinity` trap: a non-finite setTimeout delay
    // coerces to 0, so "a very large number" would close INSTANTLY. The opt-out
    // has to be structural, and this proves it stays that way.
    const onIdle = vi.fn();
    renderHook(() => useIdleAutoClose(true, onIdle, null));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(onIdle).not.toHaveBeenCalled();
  });
});
