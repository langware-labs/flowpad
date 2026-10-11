/**
 * A tab chip's hover card is hoverable (it carries a copy button), so a press
 * anywhere outside it must close it — not only a press of the chip itself.
 * A press inside a web app tab's iframe never reaches the document; it only
 * blurs the window with the iframe focused, and that closes the card too.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { TabStrip, type TabStripItem } from '@src/components/tabs/TabStrip';

const items: TabStripItem[] = [{ key: 'a', title: 'localhost:5021' }];

function openCard() {
  // The strip reads the current dock (`useLocation`): a router at `/` is the real answer.
  render(
    <MemoryRouter>
      <div>
        <TabStrip items={items} activeKey="a" onSelect={() => {}} onClose={() => {}} onPopout={() => {}} />
        <div data-testid="elsewhere" />
        <iframe data-testid="webapp" title="webapp" />
      </div>
    </MemoryRouter>,
  );
  // Focus opens a Radix tooltip without the hover delay.
  fireEvent.focusIn(screen.getByText('localhost:5021'));
}

const card = () => screen.queryAllByTestId('tab-tooltip-name');

describe('tab chip hover card dismissal', () => {
  afterEach(cleanup);

  it('closes on a press outside the chip and the card', async () => {
    openCard();
    expect(card().length).toBeGreaterThan(0);
    // Radix arms its outside-press listener a tick after the card opens.
    await act(() => new Promise((r) => setTimeout(r, 0)));

    fireEvent.pointerDown(screen.getByTestId('elsewhere'));
    expect(card()).toHaveLength(0);
  });

  it('stays open on a press inside the card', () => {
    openCard();
    fireEvent.pointerDown(screen.getAllByTestId('tab-tooltip-copy-name')[0]);
    expect(card().length).toBeGreaterThan(0);
  });

  it('closes when focus moves into an iframe (a press inside a web app)', () => {
    openCard();
    expect(card().length).toBeGreaterThan(0);

    act(() => {
      screen.getByTestId('webapp').focus();
      window.dispatchEvent(new Event('blur'));
    });
    expect(card()).toHaveLength(0);
  });

  it('stays open when the window blurs for another app', () => {
    openCard();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(card().length).toBeGreaterThan(0);
  });
});
