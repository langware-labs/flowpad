/**
 * `workspaceServiceUrl(node, next)` — a launch link's cloud leg lands the box ON the launch
 * path: the hub's `open-service` carries `next` through its readiness wait and sign-in gate.
 */
import { describe, expect, it } from 'vitest';
import { workspaceServiceUrl } from '@src/hooks/use-sandboxes';

const NODE = '99999999-8888-4777-8666-555555555555';

describe('workspaceServiceUrl', () => {
  it('names the service and no landing path by default', () => {
    expect(workspaceServiceUrl(NODE)).toMatch(/\/compute_node\/[^/]+\/open-service\/workspace$/);
  });

  it('carries the launch path as next', () => {
    const url = new URL(workspaceServiceUrl(NODE, '/?action=launch&target=p1&controller=c1'));
    expect(url.pathname).toMatch(/\/open-service\/workspace$/);
    expect(url.searchParams.get('next')).toBe('/?action=launch&target=p1&controller=c1');
  });
});
