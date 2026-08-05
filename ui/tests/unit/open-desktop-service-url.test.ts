/**
 * The wire contract for opening a desktop.
 *
 * `openDesktop` navigates to a hub route rather than resolving the sandbox URL
 * itself. The hub owns readiness (resume a paused box, wait for the workspace to
 * answer) and authorization; the client only names the service.
 *
 * The hub pins the same literals in `unit/test_open_service_route_contract.py`.
 * Neither half catches drift alone — that is the lesson the helpdesk mirror test
 * records, and this is its counterpart on this side of the wire.
 *
 * Asserts against `workspaceServiceUrl`, the function production navigates to.
 * Re-deriving the URL here from local copies of the literals would keep passing
 * even if `openDesktop` went back to picking a port itself — which is the exact
 * regression this guards.
 */
import { describe, it, expect } from 'vitest';
import { ComputeNode } from '@sdk';
import { WORKSPACE_SERVICE, workspaceServiceUrl } from '@src/hooks/use-desktops';

// A real v4 (version nibble 4, variant 8): TypeId validates the shape.
const NODE_ID = '11111111-2222-4333-8444-555555555555';

describe('open-service route contract', () => {
  it('addresses the compute node with the action and service the hub expects', () => {
    const url = workspaceServiceUrl(NODE_ID);

    expect(url).toContain(`/${ComputeNode.type}/`);
    expect(url).toContain(NODE_ID);
    expect(url.endsWith(`/open-service/${WORKSPACE_SERVICE}`)).toBe(true);
  });

  it('names a service and never a port', () => {
    // The port is the hub's business. A port anywhere in this URL means the
    // client is choosing an arbitrary destination inside the sandbox again.
    const url = workspaceServiceUrl(NODE_ID);

    expect(url).not.toContain('9007');
    expect(url).not.toMatch(/[?&]port=/);
  });
});
