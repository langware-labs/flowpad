/**
 * The root loader runs once, not on every navigation that changes the search string
 * (FLOWPAD-2193).
 *
 * `loadRoot` is `initSdk` + `applySupportedLocales`. React-Router re-runs a loader when the
 * search string changes, and the first tab switch after a page load does change it:
 * `?viewMode=standard&scope-…` → `?scope-…&viewMode=standard`. The re-run activated the SAME
 * locale again, Lingui announced a change, and every i18n consumer re-rendered — past its
 * `memo` — so a chat with 900 rows spent 2.7 s re-rendering on its first switch away, and
 * only that one (every later switch keeps the same string). Proven on a disposable instance
 * with the pooled chat open: `i18n.activate` fired from `loadRoot` during that switch, and
 * with the root route's `shouldRevalidate` returning false it did not (2.7 s → 0.14 s).
 *
 * OBSERVATION POINT — the real route table: `router.routes` is what `createBrowserRouter`
 * was given, so the root route's own `shouldRevalidate` is the function the router calls.
 * The arguments are the ones React-Router passes for a search-only navigation, where its
 * default answer is `true`.
 */
import { describe, expect, it, vi } from 'vitest';

// Ambient only: `createBrowserRouter` starts the first navigation (every loader, a network
// call). The route table it is GIVEN is the subject, so hand it back instead of running it.
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  createBrowserRouter: (routes: unknown) => ({
    routes,
    state: { location: { pathname: '/', search: '', hash: '' } },
    subscribe: () => () => {},
    navigate: () => Promise.resolve(),
  }),
}));

import { router } from '@src/router';

describe('the root route', () => {
  const root = router.routes.find((r) => r.path === '/');

  it('does not revalidate when only the search string changes', () => {
    expect(root, 'no root route in the route table').toBeDefined();
    expect(root!.shouldRevalidate, 'the root loader re-runs on every search change').toBeTypeOf('function');
    const answer = root!.shouldRevalidate!({
      currentUrl: new URL('http://x/dock/shell/agentic_process-a?viewMode=standard&scope-mode=project'),
      nextUrl: new URL('http://x/dock/shell/agentic_process-b?scope-mode=project&viewMode=standard'),
      currentParams: {},
      nextParams: {},
      defaultShouldRevalidate: true,
    });
    expect(answer, 'a switch between tabs re-ran the init-once root loader (re-activates the locale)').toBe(false);
  });

  it('still runs the dock loader on the same navigation', () => {
    const dock = root!.children?.find((r) => r.path === 'dock');
    expect(dock?.shouldRevalidate, 'the dock loader must re-run on a dock URL change').toBeTypeOf('function');
    const answer = dock!.shouldRevalidate!({
      currentUrl: new URL('http://x/dock/shell/agentic_process-a?viewMode=standard'),
      nextUrl: new URL('http://x/dock/shell/agentic_process-b?viewMode=standard'),
      currentParams: {},
      nextParams: {},
      defaultShouldRevalidate: false,
    });
    expect(answer).toBe(true);
  });
});
