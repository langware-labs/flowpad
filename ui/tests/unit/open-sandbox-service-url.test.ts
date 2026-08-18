/**
 * The wire contract for opening a sandbox.
 *
 * `openSandbox` navigates to a hub route rather than resolving the sandbox URL
 * itself. The hub owns readiness (resume a paused box, wait for the workspace to
 * answer) and authorization; the client only names the service.
 *
 * The hub pins the same literals in `unit/test_open_service_route_contract.py`.
 * Neither half catches drift alone — that is the lesson the helpdesk mirror test
 * records, and this is its counterpart on this side of the wire.
 *
 * Asserts against `workspaceServiceUrl`, the function production navigates to.
 * Re-deriving the URL here from local copies of the literals would keep passing
 * even if `openSandbox` went back to picking a port itself — which is the exact
 * regression this guards.
 */
import { describe, it, expect } from 'vitest';
import { ComputeNode } from '@sdk';
import { isSandbox, nextSandboxName, WORKSPACE_SERVICE, workspaceServiceUrl } from '@src/hooks/use-sandboxes';

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
    // The port is the hub's business. A port in the ROUTE means the client is
    // choosing an arbitrary destination inside the sandbox again.
    //
    // Route, not the whole URL. `fullActionUrl` is absolute, so the origin is in
    // the string too — and the origin under test is `http://localhost:9007`,
    // which made a bare `not.toContain('9007')` fail on the hub's own host and
    // say nothing at all about what this guards.
    const { pathname, search } = new URL(workspaceServiceUrl(NODE_ID), window.location.origin);
    const route = `${pathname}${search}`;

    expect(route).not.toContain('9007');
    expect(route).not.toMatch(/[?&]port=/);
  });
});

/**
 * `nextSandboxName` — the counter has to survive the rename.
 *
 * Boxes created before it are still called "Desktop N" in the database. Nothing
 * rewrites them, so the name generator has to READ both spellings or it hands
 * the user a "Sandbox 1" sitting directly under the "Desktop 3" they made
 * yesterday.
 */
describe('nextSandboxName', () => {
  const box = (name: string) => ({ name }) as never;

  it('continues the sequence', () => {
    expect(nextSandboxName([box('Sandbox 1'), box('Sandbox 3')])).toBe('Sandbox 4');
  });

  it('counts pre-rename boxes too', () => {
    expect(nextSandboxName([box('Desktop 3')])).toBe('Sandbox 4');
    expect(nextSandboxName([box('Desktop 7'), box('Sandbox 2')])).toBe('Sandbox 8');
  });

  it('starts at 1 with nothing to go on', () => {
    expect(nextSandboxName([])).toBe('Sandbox 1');
  });

  it('ignores names that only look like the pattern', () => {
    // A user-renamed box must not silently drive the counter.
    expect(nextSandboxName([box('Sandbox'), box('Sandbox x'), box('My Sandbox 9'), box('sandbox 9')])).toBe(
      'Sandbox 1',
    );
  });
});

/** `isSandbox` — which ComputeNodes are ours. */
describe('isSandbox', () => {
  // A real entity, not a shaped literal: the rule lives on `ComputeNode` now, so
  // a plain object would answer `undefined` and prove nothing about production.
  const node = (over: Record<string, unknown> = {}) =>
    new ComputeNode({ node_provider_type: 'e2b', node_config: { flavor: 'workspace' }, ...over } as never);

  it('accepts an E2B node with the workspace flavor', () => {
    expect(isSandbox(node())).toBe(true);
  });

  it('accepts a GCP VM node with the workspace flavor', () => {
    expect(isSandbox(node({ node_provider_type: 'gcp_vm' }))).toBe(true);
  });

  it('rejects anything else', () => {
    // Agent/exec-env nodes are ComputeNodes too and must never show up as the
    // user's sandboxes.
    expect(isSandbox(node({ node_provider_type: 'local_machine' }))).toBe(false);
    expect(isSandbox(node({ node_config: undefined }))).toBe(false);
    expect(isSandbox(node({ node_config: {} }))).toBe(false);
    expect(isSandbox(node({ node_config: { flavor: 'agent' } }))).toBe(false);
  });
});
