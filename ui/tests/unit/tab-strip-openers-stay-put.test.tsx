/**
 * The strip's openers (its `trailing` slot: the quick-launch slot, "+") sit
 * right after the tab row, and Close All is the strip's LAST control.
 *
 * Regression (2026-10-07, live on htab-8): Close All appears at 2+ tabs and
 * used to render between the row and the openers, sliding them left and
 * landing exactly where "Start Claude" had been — so clicking Start Claude
 * twice on the same spot opened a session, then closed every tab. The fix put
 * Close All AFTER the openers (2026-10-10): appearing never moves them. jsdom
 * has no layout, so the invariant is pinned at its source: the openers keep
 * the same position in both states, and Close All comes after them.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';

const renderStrip = (items: TabStripItem[]) =>
  render(
    <MemoryRouter>
      <TabStrip
        items={items}
        activeKey="a"
        onSelect={() => {}}
        onClose={() => {}}
        onCloseMany={() => {}}
        trailing={<button data-testid="opener">Start Claude</button>}
        testId="strip"
      />
    </MemoryRouter>,
  );

const strip = () => screen.getByTestId('strip');
const openerIndex = () =>
  Array.from(strip().children).findIndex((child) => child.contains(screen.getByTestId('opener')));

describe('the strip openers stay put; Close All is last', () => {
  afterEach(cleanup);

  it('one tab: no Close All, openers right after the tab row', () => {
    renderStrip([{ key: 'a', title: 'Alpha' }]);
    expect(screen.queryByTestId('close-all-tabs-button')).toBeNull();
    expect(openerIndex()).toBe(1);
  });

  it('two tabs: Close All appears AFTER the openers, which do not move', () => {
    renderStrip([
      { key: 'a', title: 'Alpha' },
      { key: 'b', title: 'Bravo' },
    ]);
    const closeAll = screen.getByTestId('close-all-tabs-button');
    const opener = screen.getByTestId('opener');
    expect(openerIndex()).toBe(1);
    expect(strip().lastElementChild?.contains(closeAll)).toBe(true);
    expect(opener.compareDocumentPosition(closeAll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The same shape as "+" (h-7, rounded, bordered) and a clear gap from the openers.
    expect(closeAll.className).toMatch(/\bh-7\b/);
    expect(closeAll.className).toMatch(/\bms-3\b/);
  });
});
