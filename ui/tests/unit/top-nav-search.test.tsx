/**
 * The address bar's search mode.
 *
 * Two things are worth pinning: results reach the shared activator (so the
 * omnibox opens what every other search surface would open), and the list is
 * keyboard-driven — an address bar reached by keyboard whose results need a
 * mouse is half a feature, which is why the list is a cmdk `Command`.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openDock = vi.hoisted(() => vi.fn());
const navigateToResult = vi.hoisted(() => vi.fn());
const searchResults = vi.hoisted(() => ({
  current: [
    { record_id: 'r1', record_type: 'markdown', name: 'Design notes', fts_title: 'Design notes' },
    { record_id: 'r2', record_type: 'markdown', name: 'Design review', fts_title: 'Design review' },
  ] as unknown[],
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock }, currentDock: null }),
}));
vi.mock('@src/navigation/record-type-nav', () => ({ navigateToResult }));
vi.mock('@src/hooks/use-record-search', () => ({
  MIN_SEARCH_QUERY_LENGTH: 2,
  useRecordSearch: () => ({ results: searchResults.current, isLoading: false }),
}));
vi.mock('@src/hooks/use-default-scope-filter', () => ({
  useDefaultScopeFilter: () => [null, vi.fn(), null],
}));

import { AddressSearchField } from '@src/components/top-nav-bar/AddressSearchField';

// cmdk keeps the highlighted row in view; jsdom has no layout and so no
// scrollIntoView. Stubbing it is what makes the keyboard path testable at all.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

describe('the address bar in search mode', () => {
  it('opens the panel only once the query is long enough to search', async () => {
    const user = userEvent.setup();
    render(<AddressSearchField onClose={vi.fn()} />);

    await user.type(screen.getByTestId('top-nav-search-input'), 'd');
    expect(screen.queryByTestId('top-nav-search-results')).toBeNull();

    await user.type(screen.getByTestId('top-nav-search-input'), 'e');
    await waitFor(() => expect(screen.getByTestId('top-nav-search-results')).toBeTruthy());
  });

  // The reason the list is cmdk and not a stack of buttons.
  it('selects a result with the arrows and Enter, and closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AddressSearchField onClose={onClose} />);

    await user.type(screen.getByTestId('top-nav-search-input'), 'design');
    await waitFor(() => expect(screen.getAllByTestId('top-nav-search-result')).toHaveLength(2));

    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => expect(navigateToResult).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
