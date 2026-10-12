/**
 * The tab strip's scanner: hovering a chip whose title is cut shows that tab at
 * full width, drawn over the strip. It grows backward over the tabs already
 * passed (left in LTR, right in RTL) so the ones ahead stay visible, and it
 * never moves or resizes a chip.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';
import { SCAN_LABEL_MAX_PX, scanLabelBox } from '@src/components/tabs/TabScanLabel';

const locale = vi.hoisted(() => ({ dir: 'ltr' as 'ltr' | 'rtl' }));
vi.mock('@src/contexts/locale-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/contexts/locale-context')>()),
  useLocaleInfo: () => ({ dir: locale.dir }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  locale.dir = 'ltr';
});

const CHIP = { left: 500, right: 540, top: 10, height: 35 };
const ROW = { left: 50, right: 950 };

describe('scanLabelBox', () => {
  it('LTR: ends before the close button and grows left', () => {
    const { slot, labelMinWidth } = scanLabelBox(CHIP, 18, 'ltr', ROW, 1000);
    // slot = [edge - max, edge]; the label is end-aligned inside it.
    expect(slot).toMatchObject({ top: 10, height: 35, left: 522 - SCAN_LABEL_MAX_PX, minWidth: SCAN_LABEL_MAX_PX });
    expect(labelMinWidth).toBe(22);
  });

  it('RTL: mirrored — starts after the close button and grows right', () => {
    const { slot } = scanLabelBox(CHIP, 18, 'rtl', ROW, 1000);
    expect(slot).toMatchObject({ right: 1000 - (518 + SCAN_LABEL_MAX_PX), minWidth: SCAN_LABEL_MAX_PX });
    expect(slot.left).toBeUndefined();
  });

  it('near the row start the slot begins at the row edge, so a long title runs forward', () => {
    const ltr = scanLabelBox({ ...CHIP, left: 60, right: 100 }, 0, 'ltr', ROW, 1000).slot;
    expect(ltr).toMatchObject({ left: 50, minWidth: 50 });
    const rtl = scanLabelBox({ ...CHIP, left: 900, right: 940 }, 0, 'rtl', ROW, 1000).slot;
    expect(rtl).toMatchObject({ right: 50, minWidth: 50 });
  });
});

const ITEMS: TabStripItem[] = [
  { key: 'a', title: 'assess-agent-simulation-readiness', testId: 'chip-a', renameable: true },
  { key: 'b', title: 'short', testId: 'chip-b' },
];

function renderStrip(onReorderPreview?: () => void) {
  render(
    <TabStrip items={ITEMS} activeKey="b" onSelect={() => {}} onClose={() => {}} onReorderPreview={onReorderPreview} />,
  );
  // jsdom lays nothing out: say that chip a's title is cut and chip b's is not.
  const title = screen.getByTestId('chip-a').querySelector('[data-tab-title]') as HTMLElement;
  Object.defineProperty(title, 'scrollWidth', { value: 240 });
  Object.defineProperty(title, 'clientWidth', { value: 30 });
}

const hover = (testId: string) => fireEvent.pointerEnter(screen.getByTestId(testId));

describe('TabStrip scanner', () => {
  it('shows the full title for a cut chip, and nothing for one that fits', () => {
    renderStrip();
    hover('chip-b');
    expect(screen.queryByTestId('tab-scan-label')).toBeNull();

    hover('chip-a');
    expect(screen.getByTestId('tab-scan-label').textContent).toBe('assess-agent-simulation-readiness');

    fireEvent.pointerLeave(screen.getByTestId('terminal-tabs-row'));
    expect(screen.queryByTestId('tab-scan-label')).toBeNull();

    hover('chip-a');
    hover('chip-b');
    expect(screen.queryByTestId('tab-scan-label')).toBeNull();
  });

  it('steps aside once the pointer has settled on the tab', () => {
    vi.useFakeTimers();
    renderStrip();
    hover('chip-a');
    act(() => void vi.advanceTimersByTime(1999));
    expect(screen.queryByTestId('tab-scan-label')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('tab-scan-label')).toBeNull();
  });

  it('a drag or a rename ends the scan', () => {
    renderStrip(() => {});
    const chip = screen.getByTestId('chip-a');

    hover('chip-a');
    fireEvent.pointerDown(chip, { clientX: 10 });
    fireEvent.pointerMove(window, { clientX: 40 });
    expect(screen.queryByTestId('tab-scan-label')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 40 });
    // The chips have moved: the label must not come back at the old spot.
    expect(screen.queryByTestId('tab-scan-label')).toBeNull();

    hover('chip-a');
    expect(screen.queryByTestId('tab-scan-label')).not.toBeNull();
    fireEvent.doubleClick(chip.querySelector('[data-tab-title]') as HTMLElement);
    expect(screen.queryByTestId('tab-scan-label')).toBeNull();
  });
});

describe('TabStrip drag-reorder follows the reading direction', () => {
  const THREE: TabStripItem[] = ['a', 'b', 'c'].map((key) => ({ key, title: key, testId: `chip-${key}` }));

  // Lays the three 40px chips out in reading order and drags `a` past `b`.
  function dragAPastB(dir: 'ltr' | 'rtl') {
    locale.dir = dir;
    const onReorderCommit = vi.fn();
    render(
      <TabStrip
        items={THREE}
        activeKey="c"
        onSelect={() => {}}
        onClose={() => {}}
        onReorderPreview={() => {}}
        onReorderCommit={onReorderCommit}
      />,
    );
    THREE.forEach(({ key }, i) => {
      const left = dir === 'rtl' ? 80 - i * 40 : i * 40;
      screen.getByTestId(`chip-${key}`).getBoundingClientRect = () => ({ left, width: 40 }) as DOMRect;
    });
    const [from, to] = dir === 'rtl' ? [100, 50] : [20, 70];
    // jsdom has no PointerEvent, so fireEvent.pointer* drops clientX.
    const pointer = (type: string, clientX: number) => new MouseEvent(type, { clientX, bubbles: true });
    fireEvent(screen.getByTestId('chip-a'), pointer('pointerdown', from));
    fireEvent(window, pointer('pointermove', to));
    fireEvent(window, pointer('pointerup', to));
    return onReorderCommit;
  }

  it('LTR: dragging right past a chip drops after it', () => {
    expect(dragAPastB('ltr')).toHaveBeenCalledWith('a', 'b', 'c');
  });

  it('RTL: dragging left past a chip drops after it', () => {
    expect(dragAPastB('rtl')).toHaveBeenCalledWith('a', 'b', 'c');
  });
});
