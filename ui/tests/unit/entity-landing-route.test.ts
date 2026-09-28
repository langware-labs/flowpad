/**
 * The entry landing routes against the REAL route table: the risk of a root
 * two-segment dynamic route is matching a URL another route owns, so this asks
 * the same ranking the app runs (`router.routes`), not a copied table.
 */
import { matchRoutes, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';

const ID = 'a74e685c-348b-48fa-87fa-f84f742c7e06';

// `@src/router` builds its router at import time; hydration data for the only
// matched loader (the root) keeps it from running `loadRoot` here.
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
    expect(leafRoute(`/team/${ID}`)).toBe(':entityType/:entityId');
    expect(leafRoute(`/foo/not-a-uuid`)).toBe(':entityType/:entityId');
  });

  it('sends a project to its own share landing, not the generic one', () => {
    expect(leafRoute(`/project/${ID}`)).toBe('project/:projectId');
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
