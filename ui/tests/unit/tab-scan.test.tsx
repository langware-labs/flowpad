/**
 * The tab strip's scanner: hovering a chip whose title is cut widens that tab
 * in place to its full title, drawn over the strip. A scan runs toward the
 * row's start, so the tab widens toward the end (right in LTR, left in RTL),
 * over the tabs already passed, and it never moves or resizes a chip.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabStrip, type TabStripItem, type TabStripProps } from '@src/components/tabs/TabStrip';
import { scanTabBox, type ScanAnchor } from '@src/components/tabs/tab-scan';

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

const anchor = (dir: 'ltr' | 'rtl', left = 500): ScanAnchor => ({
  chip: { left, right: left + 40, top: 10, height: 35 },
  row: { left: 50, right: 950 },
  dir,
  viewportPx: 1000,
});

describe('scanTabBox', () => {
  it('LTR: keeps the chip\'s left edge and widens right', () => {
    expect(scanTabBox(anchor('ltr'), 120)).toEqual({
      forward: true,
      style: { top: '10px', height: '35px', width: '120px', left: '500px', right: '' },
    });
  });

  it('RTL: mirrored — keeps the chip\'s right edge and widens left', () => {
    expect(scanTabBox(anchor('rtl'), 120).style).toMatchObject({ left: '', right: '460px' });
  });

  it('widens forward only while the tab fits before the row end', () => {
    expect(scanTabBox(anchor('ltr', 800), 150).forward).toBe(true);
    expect(scanTabBox(anchor('ltr', 801), 150).forward).toBe(false);
    expect(scanTabBox(anchor('rtl', 160), 150).forward).toBe(true);
    expect(scanTabBox(anchor('rtl', 159), 150).forward).toBe(false);
  });

  it('with no room before the row end, keeps the other edge and widens back', () => {
    expect(scanTabBox(anchor('ltr', 900), 120).style).toMatchObject({ left: '', right: '60px' });
    expect(scanTabBox(anchor('rtl', 60), 120).style).toMatchObject({ left: '60px', right: '' });
  });
});

const ITEMS: TabStripItem[] = [
  { key: 'a', title: 'assess-agent-simulation-readiness', testId: 'chip-a', renameable: true },
  { key: 'b', title: 'short', testId: 'chip-b' },
];

function renderStrip(props: Partial<TabStripProps> = {}) {
  render(<TabStrip items={ITEMS} activeKey="b" onSelect={() => {}} onClose={() => {}} {...props} />);
  // jsdom lays nothing out: say that chip a's title is cut and chip b's is not.
  const title = screen.getByTestId('chip-a').querySelector('[data-tab-title]') as HTMLElement;
  Object.defineProperty(title, 'scrollWidth', { value: 240 });
  Object.defineProperty(title, 'clientWidth', { value: 30 });
}

const hover = (testId: string) => fireEvent.pointerEnter(screen.getByTestId(testId));

describe('TabStrip scanner', () => {
  it('widens a cut chip to its full title, and leaves one that fits alone', () => {
    renderStrip();
    hover('chip-b');
    expect(screen.queryByTestId('tab-scan-tab')).toBeNull();

    hover('chip-a');
    expect(screen.getByTestId('tab-scan-tab').textContent).toBe('assess-agent-simulation-readiness');

    // Still scanning anywhere on the row or on the widened tab itself...
    fireEvent(screen.getByTestId('terminal-tabs-row'), new MouseEvent('pointermove', { bubbles: true }));
    fireEvent(screen.getByTestId('tab-scan-tab'), new MouseEvent('pointermove', { bubbles: true }));
    expect(screen.queryByTestId('tab-scan-tab')).not.toBeNull();

    // ...and over once the pointer is anywhere else.
    fireEvent(document.body, new MouseEvent('pointermove', { bubbles: true }));
    expect(screen.queryByTestId('tab-scan-tab')).toBeNull();

    hover('chip-a');
    hover('chip-b');
    expect(screen.queryByTestId('tab-scan-tab')).toBeNull();
  });

  it('the widened tab is the tab: it selects and closes', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderStrip({ onSelect, onClose });
    hover('chip-a');

    const tab = screen.getByTestId('tab-scan-tab');
    fireEvent.click(tab);
    expect(onSelect).toHaveBeenCalledWith('a');
    fireEvent.click(within(tab).getByLabelText('Close tab'));
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('a drag or a rename ends the scan', () => {
    renderStrip({ onReorderPreview: () => {} });
    const chip = screen.getByTestId('chip-a');

    hover('chip-a');
    fireEvent.pointerDown(chip, { clientX: 10 });
    fireEvent.pointerMove(window, { clientX: 40 });
    expect(screen.queryByTestId('tab-scan-tab')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 40 });
    // The chips have moved: the widened tab must not come back at the old spot.
    expect(screen.queryByTestId('tab-scan-tab')).toBeNull();

    hover('chip-a');
    expect(screen.queryByTestId('tab-scan-tab')).not.toBeNull();
    fireEvent.doubleClick(chip.querySelector('[data-tab-title]') as HTMLElement);
    expect(screen.queryByTestId('tab-scan-tab')).toBeNull();
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
