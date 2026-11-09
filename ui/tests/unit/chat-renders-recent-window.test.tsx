/**
 * Perf hunt 2026-11-07 (B3): opening a 379-message chat mounted every row and parsed every
 * message's markdown (0.5 s, a 0.86 s main-thread task, 11.8k DOM nodes) to show the last
 * screenful. The list now mounts the recent rows and adds older ones as the reader nears the top;
 * a row a pane scrolls to is always mounted. jsdom has no IntersectionObserver, so the test
 * supplies one and fires it the way a scroll toward the top would.
 */
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowData, FlowElementTypes } from '@sdk';
import type { TurnGroup } from '@src/components/floating-chat/groupTurnEvents';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';
import { RECENT_WINDOW } from '@src/components/entity-execution-panel/use-recent-window';

const near: Array<(entries: Array<{ isIntersecting: boolean; rootBounds?: { height: number } }>) => void> = [];
vi.stubGlobal(
  'IntersectionObserver',
  class {
    constructor(cb: (entries: Array<{ isIntersecting: boolean; rootBounds?: { height: number } }>) => void) {
      near.push(cb);
    }
    observe() {}
    disconnect() {}
  },
);
afterEach(() => (near.length = 0));

const groups: TurnGroup[] = Array.from({ length: 100 }, (_, i) => ({
  kind: 'message',
  index: i,
  flowData: new FlowData(FlowElementTypes.USER_MESSAGE, `message ${i}`, { i: String(i), role: 'user' }),
}));

const rows = (c: HTMLElement) => c.querySelectorAll('div.contents[data-role]').length;
const show = (anchorIndex: number | null = null) =>
  render(
    <MemoryRouter>
      <TurnGroupsList groups={groups} anchorIndex={anchorIndex} />
    </MemoryRouter>,
  ).container;

describe('TurnGroupsList', () => {
  it('mounts the recent rows, and older ones as the top comes near', () => {
    const c = show();
    expect(rows(c)).toBe(RECENT_WINDOW);
    expect(c.textContent).toContain('message 99');

    act(() => near.at(-1)!([{ isIntersecting: true, rootBounds: { height: 600 } }]));
    expect(rows(c)).toBe(2 * RECENT_WINDOW);
  });

  it('a hidden pane (no geometry) adds nothing', () => {
    const c = show();
    act(() => near.at(-1)!([{ isIntersecting: true, rootBounds: { height: 0 } }]));
    expect(rows(c)).toBe(RECENT_WINDOW);
  });

  it('always mounts the row a pane scrolls to', () => {
    const c = show(3);
    expect(c.querySelector('[data-chat-anchor]')).not.toBeNull();
    expect(c.textContent).toContain('message 3');
  });
});
