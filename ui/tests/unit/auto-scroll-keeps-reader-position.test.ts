/**
 * A reader scrolled up in the chat stays where they are when new replies land;
 * they get a "new messages" flag instead, and an explicit scrollToBottom brings
 * them back and re-arms following.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAutoScroll } from '@src/hooks/use-auto-scroll';

/** 500px of content in a 100px viewport. */
function scrollable(): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
  return el;
}

describe('useAutoScroll follow()', () => {
  it('scrolls down only while the reader is at the bottom', () => {
    const el = scrollable();
    const { result } = renderHook(() => useAutoScroll());
    result.current.scrollRef.current = el;

    // The reader scrolls up.
    el.scrollTop = 100;
    act(() => result.current.disableAutoScroll());
    expect(result.current.isAtBottom).toBe(false);

    // A reply lands: position kept, flag raised.
    act(() => result.current.follow());
    expect(el.scrollTop).toBe(100);
    expect(result.current.hasNewContent).toBe(true);

    // Clicking the indicator returns to the latest line and clears the flag.
    act(() => result.current.scrollToBottom(true));
    expect(el.scrollTop).toBe(400);
    expect(result.current.isAtBottom).toBe(true);
    expect(result.current.hasNewContent).toBe(false);

    // Back at the bottom, the next reply is followed again.
    el.scrollTop = 400;
    act(() => result.current.follow());
    expect(result.current.hasNewContent).toBe(false);
  });
});
