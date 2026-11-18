/** A markdown tab that is left and reopened comes back at the offset it was scrolled to. */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRememberedScroll } from '@src/components/milkdown-editor/MilkdownEditor';

function scroller(height: number): HTMLDivElement {
  const el = document.createElement('div');
  el.appendChild(document.createElement('div'));
  Object.defineProperty(el, 'scrollHeight', { value: height, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
  return el;
}

describe('useRememberedScroll', () => {
  it('puts back the offset the document was left at', () => {
    const first = scroller(2000);
    const run1 = renderHook(() => useRememberedScroll(first, 'doc-a'));
    first.scrollTop = 640;
    first.dispatchEvent(new Event('scroll'));
    run1.unmount();

    const second = scroller(2000);
    renderHook(() => useRememberedScroll(second, 'doc-a'));
    expect(second.scrollTop).toBe(640);
  });

  it('keeps documents apart', () => {
    const other = scroller(2000);
    renderHook(() => useRememberedScroll(other, 'doc-b'));
    expect(other.scrollTop).toBe(0);
  });
});
