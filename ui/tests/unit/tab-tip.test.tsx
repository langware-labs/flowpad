/**
 * A tab's tip, shown under the chip: the strip's own header — the tab's full
 * title, which the chip may cut — over the body that kind of tab defines. The
 * chip itself never widens or moves.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';
import { TabTooltipName } from '@src/components/tabs/TabTooltipName';

afterEach(cleanup);

function openTip(item: TabStripItem) {
  render(
    <MemoryRouter>
      <TabStrip items={[item]} activeKey="other" onSelect={() => {}} onClose={() => {}} />
    </MemoryRouter>,
  );
  // Focus opens a Radix tooltip without the hover delay.
  fireEvent.focusIn(screen.getByTestId('chip'));
}

// Radix renders the content twice (once for screen readers): compare the set.
const names = () => [...new Set(screen.queryAllByTestId('tab-tooltip-name').map((el) => el.textContent))];

describe('tab tip', () => {
  it('a tab with no body shows its full title', () => {
    openTip({ key: 'a', title: 'Message channel setup states for every provider', testId: 'chip' });
    expect(names()).toEqual(['Message channel setup states for every provider']);
  });

  it('a body sits under the header, and its own name line drops out', () => {
    openTip({
      key: 'a',
      title: 'Message channel setup states for every provider',
      testId: 'chip',
      card: (
        <div data-testid="body">
          <TabTooltipName name="the same card names itself on a breadcrumb" />
          <p>Claude · running</p>
        </div>
      ),
    });
    expect(names()).toEqual(['Message channel setup states for every provider']);
    expect(screen.getAllByTestId('body')[0].textContent).toBe('Claude · running');
  });

  it('a chip standing in for another tab is headed by what it displays', () => {
    openTip({ key: 'a', title: 'workspace', standsFor: { title: 'the child on screen' }, testId: 'chip' });
    expect(names()).toEqual(['the child on screen']);
  });

  it('a disabled tab says why under its title', () => {
    openTip({ key: 'a', title: 'session', isDisabled: true, statusReason: 'Closing...', testId: 'chip' });
    expect(names()).toEqual(['session']);
    expect(screen.getAllByText('Closing...').length).toBeGreaterThan(0);
  });
});
