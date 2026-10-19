/**
 * Dragging a chip past a neighbour reorders the strip, and "past" follows the
 * reading direction.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';

const locale = vi.hoisted(() => ({ dir: 'ltr' as 'ltr' | 'rtl' }));
vi.mock('@src/contexts/locale-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/contexts/locale-context')>()),
  useLocaleInfo: () => ({ dir: locale.dir }),
}));

afterEach(() => {
  cleanup();
  locale.dir = 'ltr';
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
