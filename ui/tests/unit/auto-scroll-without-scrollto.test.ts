/**
 * `scrollToBottom` must not require `Element.prototype.scrollTo`.
 *
 * jsdom implements the `scrollTop` PROPERTY but not the `scrollTo` METHOD, and
 * whether it is present at all varies by patch version — so this reproduced on
 * CI while passing locally. Any test mounting a chat pane died with
 *
 *   TypeError: el.scrollTo is not a function
 *     ❯ Object.scrollToBottom  src/hooks/use-auto-scroll.ts:34
 *     ❯ SimpleChatPane.tsx:69
 *
 * and because the unit tier runs with `--bail 1`, that single throw aborted the
 * whole suite and skipped the i18n step behind it.
 *
 * The smooth path is a nicety: assigning `scrollTop` reaches the same offset.
 * So the fix falls back rather than skipping — an optional call
 * (`el.scrollTo?.(…)`) would type-check and never scroll, which is worse than
 * the crash because nothing would say so.
 *
 * This test deletes the method to recreate the environment CI actually has.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAutoScroll } from '@src/hooks/use-auto-scroll';

const proto = Element.prototype as unknown as { scrollTo?: unknown };
const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo');

afterEach(() => {
  if (original) Object.defineProperty(Element.prototype, 'scrollTo', original);
});

/** A scrollable element: 500px of content in a 100px viewport. */
function scrollable(): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
  return el;
}

describe('useAutoScroll on a jsdom without Element.prototype.scrollTo', () => {
  it('still scrolls to the bottom instead of throwing', () => {
    delete proto.scrollTo; // exactly what CI's jsdom looks like
    expect(typeof (scrollable() as unknown as { scrollTo?: unknown }).scrollTo).toBe('undefined');

    const el = scrollable();
    const { result } = renderHook(() => useAutoScroll());
    result.current.scrollRef.current = el;

    expect(() => result.current.scrollToBottom()).not.toThrow();
    expect(el.scrollTop).toBe(400); // scrollHeight - clientHeight
  });
});
