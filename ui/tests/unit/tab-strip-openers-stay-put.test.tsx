/**
 * The strip's openers (its `trailing` slot: Start Claude, "+") are the LAST
 * thing in the strip whatever else shows.
 *
 * Regression (2026-10-07, live on htab-8): Close All appears at 2+ tabs and
 * used to render AFTER the openers, sliding them left and landing exactly where
 * "Start Claude" had been — so clicking Start Claude twice on the same spot
 * opened a session, then closed every tab. jsdom has no layout, so the
 * invariant is pinned at its source: the openers are the strip's last child in
 * both states, Close All never comes after them.
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

const lastChild = () => screen.getByTestId('strip').lastElementChild;

describe('the strip openers stay pinned at its end', () => {
  afterEach(cleanup);

  it('one tab: no Close All, openers last', () => {
    renderStrip([{ key: 'a', title: 'Alpha' }]);
    expect(screen.queryByTestId('close-all-tabs-button')).toBeNull();
    expect(lastChild()?.contains(screen.getByTestId('opener'))).toBe(true);
  });

  it('two tabs: Close All appears BEFORE the openers, never after', () => {
    renderStrip([
      { key: 'a', title: 'Alpha' },
      { key: 'b', title: 'Bravo' },
    ]);
    const closeAll = screen.getByTestId('close-all-tabs-button');
    const opener = screen.getByTestId('opener');
    expect(lastChild()?.contains(opener)).toBe(true);
    expect(closeAll.compareDocumentPosition(opener) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
