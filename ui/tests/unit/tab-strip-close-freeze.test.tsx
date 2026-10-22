/**
 * Close-in-place in the real TabStrip: mouse closes freeze tab widths, the next
 * close button lands under the cursor, and the strip releases on leave, open,
 * resize, reorder, batch close and idle. jsdom has no layout, so tab/separator
 * widths are mocked and positions are computed from the rendered inline styles.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';
import { FREEZE_IDLE_MS, FREEZE_LEAVE_DELAY_MS } from '@src/components/tabs/close-freeze';

const TAB_PX = 120;
const SEP_PX = 1;
const ROW_PX = 1200;
/** Distance from a tab's end edge to the centre of its close button. */
const CLOSE_INSET = 10;

const make = (n: number): TabStripItem[] => Array.from({ length: n }, (_, i) => ({ key: `t${i}`, title: `Tab ${i}` }));

let api: { add: () => void; closeMany: (k: string[]) => void } = { add: () => {}, closeMany: () => {} };
const onCloseSpy = vi.fn();
const onPopout = vi.fn();

function Harness({ n, active = 't0' }: { n: number; active?: string }) {
  const [items, setItems] = useState(() => make(n));
  api = {
    add: () => setItems((xs) => [...xs, { key: `new${xs.length}`, title: 'New' }]),
    closeMany: (keys) => setItems((xs) => xs.filter((x) => !keys.includes(x.key))),
  };
  return (
    <MemoryRouter>
      <TabStrip
        items={items}
        activeKey={active}
        onSelect={() => {}}
        onClose={(k) => {
          onCloseSpy(k);
          setItems((xs) => xs.filter((x) => x.key !== k));
        }}
        onCloseMany={(keys) => api.closeMany(keys)}
        onPopout={onPopout}
        onReorderPreview={() => {}}
        onReorderCommit={(k) => setItems((xs) => [...xs.filter((x) => x.key !== k), xs.find((x) => x.key === k)!])}
      />
    </MemoryRouter>
  );
}

const row = () => screen.getByTestId('terminal-tabs-row');
const strip = () => screen.getByTestId('terminal-tab-bar');
const chips = () => Array.from(row().querySelectorAll<HTMLElement>('[data-terminal-target]'));
const keys = () => chips().map((c) => c.getAttribute('data-terminal-target'));
const pad = () => screen.queryByTestId('tab-strip-lead-pad');
const padPx = () => (pad() ? parseFloat(pad()!.style.flex.split(' ')[2]) : 0);
const chip = (key: string) => row().querySelector<HTMLElement>(`[data-terminal-target="${key}"]`)!;
const clickClose = (key: string) => fireEvent.click(chip(key).querySelector('button[aria-label="Close tab"]')!);

function expectFrozen(px: number) {
  expect(row().dataset.frozen).toBe('true');
  for (const c of chips()) {
    expect(c.style.flex).toBe(`0 0 ${px}px`);
    expect(c.style.minWidth).toBe(`${px}px`);
    expect(c.style.maxWidth).toBe(`${px}px`);
  }
}
function expectNormal() {
  expect(pad()).toBeNull();
  expect(row().dataset.frozen).toBeUndefined();
  for (const c of chips()) {
    expect(c.style.flex).toBe('1 1 200px');
    expect(c.style.minWidth).toBe('40px');
    expect(c.style.maxWidth).toBe('200px');
  }
}

/** Layout model of the row: [pad][chip][sep][chip]… ; returns each chip's close-button x. */
function closeXs(): Map<string, number> {
  const out = new Map<string, number>();
  let x = padPx();
  chips().forEach((c, i) => {
    if (i > 0) x += SEP_PX;
    const w = row().dataset.frozen ? parseFloat(c.style.flex.split(' ')[2]) : TAB_PX;
    x += w;
    out.set(c.getAttribute('data-terminal-target')!, x - CLOSE_INSET);
  });
  return out;
}
const keyUnderCursor = (x: number) => [...closeXs()].find(([, cx]) => Math.abs(cx - x) < 0.01)?.[0];

let stripPx = ROW_PX + 100;
const observers: Array<{ cb: ResizeObserverCallback; el?: Element }> = [];
class FakeResizeObserver {
  entry: { cb: ResizeObserverCallback; el?: Element };
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.el = el;
  }
  unobserve() {}
  disconnect() {
    observers.splice(observers.indexOf(this.entry), 1);
  }
}
/** Resize the strip and fire the observers watching it. */
function resizeStrip(px: number) {
  stripPx = px;
  for (const o of [...observers]) if (o.el === strip()) o.cb([], o as unknown as ResizeObserver);
}

beforeEach(() => {
  vi.useFakeTimers();
  stripPx = ROW_PX + 100;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  onCloseSpy.mockReset();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const w = this.hasAttribute('data-terminal-target') ? TAB_PX : this.getAttribute('aria-hidden') ? SEP_PX : 0;
    return { width: w, height: 30, left: 0, right: w, top: 0, bottom: 30, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'terminal-tab-bar') return stripPx;
    return this.dataset.testid === 'terminal-tabs-row' ? ROW_PX : 0;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('freeze on mouse close', () => {
  it('starts in the normal layout', () => {
    render(<Harness n={6} />);
    expectNormal();
  });

  it('closing a middle tab freezes every remaining tab at the clicked width, no spacer', () => {
    render(<Harness n={6} />);
    clickClose('t2');
    expect(keys()).toEqual(['t0', 't1', 't3', 't4', 't5']);
    expectFrozen(TAB_PX);
    expect(pad()).toBeNull();
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledWith('t2');
  });

  it('closing the last tab three times grows the spacer one stride each time', () => {
    render(<Harness n={6} />);
    clickClose('t5');
    expect(padPx()).toBe(TAB_PX + SEP_PX);
    clickClose('t4');
    expect(padPx()).toBe(2 * (TAB_PX + SEP_PX));
    clickClose('t3');
    expect(padPx()).toBe(3 * (TAB_PX + SEP_PX));
    expectFrozen(TAB_PX);
    expect(keys()).toEqual(['t0', 't1', 't2']);
  });

  it('mixed middle and end closes keep the spacer and widths right', () => {
    render(<Harness n={8} />);
    clickClose('t3'); // middle
    clickClose('t7'); // last
    clickClose('t1'); // middle
    clickClose('t6'); // last
    expect(padPx()).toBe(2 * (TAB_PX + SEP_PX));
    expectFrozen(TAB_PX);
  });

  it('closing the only tab adds no separator to the spacer', () => {
    render(<Harness n={1} />);
    clickClose('t0');
    expect(chips()).toHaveLength(0);
    expect(padPx()).toBe(TAB_PX);
  });

  it('closing the first tab with a spacer before it does not count the spacer as a separator', () => {
    render(<Harness n={3} />);
    clickClose('t2');
    clickClose('t1');
    clickClose('t0');
    expect(padPx()).toBe(2 * (TAB_PX + SEP_PX) + TAB_PX);
  });

  it('context-menu Close never freezes (only the close button does)', () => {
    render(<Harness n={4} />);
    fireEvent.contextMenu(chip('t1'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Close\s*$/ }));
    expect(keys()).toEqual(['t0', 't2', 't3']);
    expectNormal();
  });
});

describe('the next close button is under the cursor', () => {
  it.each([0, 3, 5])('closing from t%i repeatedly at one x always hits an open tab', (start) => {
    render(<Harness n={6} />);
    const x = closeXs().get(`t${start}`)!;
    for (let i = 0; i < 6; i++) {
      const k = keyUnderCursor(x);
      expect(k, `step ${i}: nothing under x=${x}, layout=${JSON.stringify([...closeXs()])}`).toBeDefined();
      clickClose(k!);
    }
    expect(chips()).toHaveLength(0);
  });

  it('10 seeded random sequences of moving the cursor and clicking', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 10; run++) {
      const { unmount } = render(<Harness n={10} />);
      let remaining = 10;
      while (remaining > 0) {
        // Pick a tab, then close a burst of tabs without moving.
        const ks = keys();
        const x = closeXs().get(ks[Math.floor(rnd() * ks.length)]!)!;
        const burst = 1 + Math.floor(rnd() * remaining);
        for (let i = 0; i < burst; i++) {
          const k = keyUnderCursor(x);
          expect(k, `run ${run}: nothing under the cursor`).toBeDefined();
          clickClose(k!);
          remaining--;
        }
        // Sometimes leave the strip so it re-lays out before the next burst.
        if (rnd() < 0.5) {
          fireEvent.pointerLeave(strip());
          void act(() => vi.advanceTimersByTime(FREEZE_LEAVE_DELAY_MS));
          expectNormal();
        }
      }
      unmount();
    }
  });
});

describe('release', () => {
  it('pointer leave: still frozen at 249ms, normal at 250ms', () => {
    render(<Harness n={6} />);
    clickClose('t5');
    fireEvent.pointerLeave(strip());
    void act(() => vi.advanceTimersByTime(FREEZE_LEAVE_DELAY_MS - 1));
    expectFrozen(TAB_PX);
    expect(padPx()).toBe(TAB_PX + SEP_PX);
    void act(() => vi.advanceTimersByTime(1));
    expectNormal();
  });

  it('leave then re-enter before the delay stays frozen', () => {
    render(<Harness n={6} />);
    clickClose('t2');
    fireEvent.pointerLeave(strip());
    void act(() => vi.advanceTimersByTime(FREEZE_LEAVE_DELAY_MS - 50));
    fireEvent.pointerEnter(strip());
    void act(() => vi.advanceTimersByTime(FREEZE_LEAVE_DELAY_MS * 2));
    expectFrozen(TAB_PX);
  });

  it('pointer leave while not frozen does nothing', () => {
    render(<Harness n={3} />);
    fireEvent.pointerLeave(strip());
    void act(() => vi.advanceTimersByTime(FREEZE_LEAVE_DELAY_MS));
    expectNormal();
  });

  it('idle: released after the idle time with no further close; each close restarts it', () => {
    render(<Harness n={6} />);
    clickClose('t1');
    void act(() => vi.advanceTimersByTime(FREEZE_IDLE_MS - 100));
    clickClose('t2');
    void act(() => vi.advanceTimersByTime(FREEZE_IDLE_MS - 1));
    expectFrozen(TAB_PX);
    void act(() => vi.advanceTimersByTime(1));
    expectNormal();
  });

  it('a newly opened tab releases at once', () => {
    render(<Harness n={4} />);
    clickClose('t3');
    void act(() => api.add());
    expectNormal();
    expect(chips()).toHaveLength(4);
  });

  it('the strip changing width releases; a resize callback at the same width does not', () => {
    render(<Harness n={4} />);
    clickClose('t1');
    void act(() => resizeStrip(stripPx));
    expectFrozen(TAB_PX);
    void act(() => resizeStrip(stripPx - 200));
    expectNormal();
  });

  it('a close from outside the strip (keyboard, owner) releases', () => {
    render(<Harness n={5} />);
    clickClose('t4');
    void act(() => api.closeMany(['t0']));
    expectNormal();
  });

  it('close-all button releases and never freezes', () => {
    render(<Harness n={4} />);
    clickClose('t3');
    fireEvent.click(screen.getByTestId('close-all-tabs-button'));
    expect(chips()).toHaveLength(0);
    expect(pad()).toBeNull();
  });

  it('Close to the Right / Close All But This never freeze', () => {
    render(<Harness n={5} />);
    clickClose('t4');
    fireEvent.contextMenu(chip('t1'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close to the Right' }));
    expect(keys()).toEqual(['t0', 't1']);
    expectNormal();
    fireEvent.contextMenu(chip('t0'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close All But This' }));
    expect(keys()).toEqual(['t0']);
    expectNormal();
  });

  it('a drag-reorder releases', () => {
    render(<Harness n={4} />);
    clickClose('t3');
    fireEvent.pointerDown(chip('t0'), { clientX: 0 });
    void act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 50 }) as PointerEvent);
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 50 }) as PointerEvent);
    });
    expectNormal();
  });
});

describe('details', () => {
  it('a tab being renamed keeps its 200px while the others are frozen', () => {
    function RenameHarness() {
      const [items, setItems] = useState<TabStripItem[]>(() => make(4).map((i) => ({ ...i, renameable: true })));
      return (
        <MemoryRouter>
          <TabStrip
            items={items}
            activeKey="t0"
            onSelect={() => {}}
            onClose={(k) => setItems((xs) => xs.filter((x) => x.key !== k))}
            onRename={() => {}}
          />
        </MemoryRouter>
      );
    }
    render(<RenameHarness />);
    clickClose('t3');
    fireEvent.doubleClick(screen.getByText('Tab 1'));
    expect(chip('t1').style.width).toBe('200px');
    expect(chip('t1').style.flex).toBe('0 0 auto'); // jsdom's spelling of flex: none
    expect(chip('t0').style.flex).toBe(`0 0 ${TAB_PX}px`);
  });

  it('density follows the frozen width, not the live share', () => {
    // 12 tabs in 1200px = 100px each = compact (no popout). Frozen at 120px the
    // tabs keep normal density even though 11 tabs would share 109px each.
    render(<Harness n={12} />);
    const popouts = () => screen.queryAllByRole('button', { name: /open in external browser/i }).length;
    expect(popouts()).toBe(0);
    clickClose('t11');
    expect(popouts()).toBe(11);
    fireEvent.pointerLeave(strip());
    void act(() => vi.advanceTimersByTime(FREEZE_LEAVE_DELAY_MS));
    expect(popouts()).toBe(0); // 11 tabs × 109px = compact again
  });

  it('width changes animate only when motion is allowed', () => {
    render(<Harness n={2} />);
    expect(chip('t0').className).toContain('motion-safe:transition-[color,background-color,border-color,flex-basis');
    expect(chip('t0').className).not.toMatch(/(^|\s)transition-\[/);
  });
});
