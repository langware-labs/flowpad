import { DockPointer } from '@src/navigation/DockPointer';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * NavigationActions.openDiscover — the one entry point to the Discover page
 * (project home button, the rail). It is a top-level route, not a dock, so
 * the project rides as the dock scope grammar in the query and the route's
 * loader adopts it; the URL round-trips through `withOptionsFromUrl`.
 */
describe('NavigationActions.openDiscover', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  it('with a project → /discover carrying that project as the scope', () => {
    const navigate = vi.fn();
    new NavigationActions(navigate, null).openDiscover(PROJECT_ID);

    expect(navigate).toHaveBeenCalledTimes(1);
    const url = String(navigate.mock.calls[0][0]);
    expect(url.startsWith('/discover?')).toBe(true);
    expect(DockPointer.root().withOptionsFromUrl(url).scopeProjectId).toBe(PROJECT_ID);
  });

  it('without a project → bare /discover (the active project stays)', () => {
    const navigate = vi.fn();
    new NavigationActions(navigate, null).openDiscover(null);
    expect(navigate).toHaveBeenCalledWith('/discover');
  });
});
