/**
 * `:entityType/:entityId` (FLOWPAD-2177) against the REAL route table.
 *
 * The route is a two-segment dynamic match at the root, so the risk is not that
 * it fails to match — it is that it matches something another route owns. This
 * asserts on `router.routes` from `@src/router` itself (not a copied table), so a
 * new static route or a reordering is checked by the same ranking the app runs.
 */
import { matchRoutes, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';

const ID = 'a74e685c-348b-48fa-87fa-f84f742c7e06';

// `@src/router` builds its browser router at import time, and a router that has
// not been hydrated starts its initial navigation — running `loadRoot` against
// the tier's no-backend URL. Hand it react-router's own hydration data for the
// root route instead, so it starts initialized and runs no loader: the route
// table is all this file reads. The URL is one only the loader-less catch-all
// matches, so the root is the only route that needs the data. Done before the
// import (hence the dynamic import below), at collection time.
window.history.replaceState(null, '', '/__route-table-test__');
(window as unknown as { __staticRouterHydrationData?: unknown }).__staticRouterHydrationData = {
  loaderData: { '0': null },
  actionData: null,
  errors: null,
};
const routes = (await import('@src/router')).router.routes as RouteObject[];

/** The path of the deepest route that renders `url`. */
function leafRoute(url: string): string | undefined {
  const matches = matchRoutes(routes, url) ?? [];
  return matches[matches.length - 1]?.route.path;
}

describe('entity landing route', () => {
  it('catches the post-accept URL the hub emits for any type', () => {
    expect(leafRoute(`/agent/${ID}`)).toBe(':entityType/:entityId');
    expect(leafRoute(`/project/${ID}`)).toBe(':entityType/:entityId');
    expect(leafRoute(`/foo/not-a-uuid`)).toBe(':entityType/:entityId');
  });

  it('leaves every existing two-segment route where it was', () => {
    expect(leafRoute(`/flow_message/${ID}`)).toBe('flow_message/:messageId');
    expect(leafRoute(`/compute_node/${ID}`)).toBe('compute_node/:nodeId');
    expect(leafRoute('/invite/some-token')).toBe('invite/:token');
    expect(leafRoute(`/discover/agent-${ID}`)).toBe('discover/:typeid');
    expect(leafRoute('/electron/keychain-approval')).toBe('electron/keychain-approval');
    expect(leafRoute('/dock/home')).toBe(':viewType');
    expect(leafRoute('/win/home')).toBe(':viewType');
    expect(leafRoute('/dev/hooks')).toBe('hooks');
  });

  it('does not take one- or three-segment URLs, which stay on the catch-all', () => {
    expect(leafRoute('/nothing-here')).toBe('*');
    expect(leafRoute(`/agent/${ID}/extra`)).toBe('*');
  });
});
