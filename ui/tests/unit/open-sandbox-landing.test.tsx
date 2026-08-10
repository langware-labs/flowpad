/**
 * `/open-sandbox` — the invitation landing, and the branch it was missing.
 *
 * The page used to do one thing: build the `open-service` URL and go. That is
 * right for a box with a VM behind it and a dead end for one without, because a
 * sandbox is WRITTEN DOWN by `createSandbox` and PROVISIONED by `launchSandbox`
 * — two separate clicks — so a machine can be shared while it is still only a
 * row. The hub answers that with 409 "this machine has not been set up yet", and
 * this is the one screen with no card and no Launch button to fall back to.
 *
 * So the three cases are asserted here as three destinations, not three
 * renderings: already launched → go, never launched → launch THEN go, and
 * cannot launch → say who can. `isLaunched` and `workspaceServiceUrl` are the
 * real ones (only `useSandboxes` is stubbed) so the branch is decided by the
 * same field the hub decides it by.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sandboxes: [] as unknown[],
  isLoading: false,
  launchSandbox: vi.fn(),
  steps: [] as unknown[],
}));

vi.mock('@src/hooks/use-sandboxes', async (importOriginal) => {
  // `isLaunched` and `workspaceServiceUrl` stay REAL: they are the contract with
  // the hub (one field, one route), and stubbing them would leave this test
  // asserting its own opinion of when a box needs launching.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSandboxes: () => ({
      sandboxes: mocks.sandboxes,
      isLoading: mocks.isLoading,
      launchSandbox: mocks.launchSandbox,
      steps: mocks.steps,
    }),
  };
});

const { default: OpenSandboxLanding } = await import('@src/pages/entry/OpenSandboxLanding');
const { workspaceServiceUrl } = await import('@src/hooks/use-sandboxes');

// A real v4 (version nibble 4, variant 8): TypeId validates the shape, and an id
// it rejects would take the "this link does not point at a sandbox" exit instead
// of the branch under test.
const NODE_ID = '11111111-2222-4333-8444-555555555555';

/** Only the two fields the page reads. `node_provider_id` IS the launched flag. */
const node = (over: Record<string, unknown> = {}) => ({ id: NODE_ID, node_provider_id: null, ...over });

const originalLocation = window.location;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.sandboxes = [];
  mocks.isLoading = false;
  mocks.steps = [];
  mocks.launchSandbox = vi.fn();
  // jsdom's real `location.assign` is unimplemented and logs a "not implemented"
  // error instead of navigating — the same swap `cloud-manager-hub-identity` makes.
  assign = vi.fn();
  delete (window as unknown as { location?: Location }).location;
  (window as unknown as { location: Partial<Location> }).location = {
    origin: originalLocation.origin,
    href: originalLocation.href,
    pathname: '/open-sandbox',
    search: `?node=${NODE_ID}`,
    assign,
  };
});

afterEach(() => {
  cleanup();
  (window as unknown as { location: Location }).location = originalLocation;
});

function renderLanding(nodeId = NODE_ID) {
  return render(
    <MemoryRouter initialEntries={[`/open-sandbox?node=${nodeId}`]}>
      <OpenSandboxLanding />
    </MemoryRouter>,
  );
}

describe('open-sandbox landing', () => {
  it('opens a launched sandbox without touching the launch path', async () => {
    mocks.sandboxes = [node({ node_provider_id: 'e2b-sandbox-1' })];

    renderLanding();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    // The box has a VM. Re-running setup on it would overwrite `node_provider_id`
    // and orphan the machine it names.
    expect(mocks.launchSandbox).not.toHaveBeenCalled();
  });

  it('launches a sandbox that was shared before it was ever started, then opens it', async () => {
    mocks.sandboxes = [node()];
    mocks.launchSandbox.mockResolvedValue(node({ node_provider_id: 'e2b-sandbox-2' }));

    renderLanding();

    await waitFor(() => expect(mocks.launchSandbox).toHaveBeenCalledTimes(1));
    // Auto-login on: a handover's recipient is this box's one person now.
    expect(mocks.launchSandbox.mock.calls[0][1]).toEqual({ autoLogin: true });
    // The redirect waits for the launch. Going first would be the 409 all over
    // again, just with a spinner in front of it.
    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
  });

  it('shows the launch checklist while it boots', async () => {
    mocks.sandboxes = [node()];
    mocks.steps = [{ id: 'launch', label: 'Starting the sandbox', status: 'loading' }];
    // Never settles: the assertion is about what is on screen DURING the launch.
    mocks.launchSandbox.mockReturnValue(new Promise(() => {}));

    renderLanding();

    await waitFor(() => expect(screen.getByTestId('open-sandbox-launching')).toBeTruthy());
    expect(screen.getByTestId('open-sandbox-launch-steps')).toBeTruthy();
    expect(screen.getByText('Starting the sandbox')).toBeTruthy();
  });

  it('names the owner when the recipient holds a plain share', async () => {
    mocks.sandboxes = [node()];
    // `ops` resolves for `owner` and nobody else, so an `admin` share — which is
    // what the dialog grants without the transfer checkbox — gets exactly this.
    mocks.launchSandbox.mockRejectedValue({ response: { status: 403 } });

    renderLanding();

    const message = await screen.findByTestId('open-sandbox-error');
    expect(message.textContent).toContain('only its owner can start it');
    // Nowhere to send them: the box has no VM, so the URL would 409.
    expect(assign).not.toHaveBeenCalled();
  });

  it('waits for the sandbox list before deciding', async () => {
    // Mid-load the list is empty, which is indistinguishable from "not launched"
    // if the page acts on it — and acting means spending money on a VM.
    mocks.isLoading = true;
    mocks.sandboxes = [];

    renderLanding();

    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.launchSandbox).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls through to the hub for a node it cannot see', async () => {
    // Not in the list: the hub authorizes this route, and its 403/404 is a
    // better answer than a guess made here.
    mocks.sandboxes = [];

    renderLanding();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    expect(mocks.launchSandbox).not.toHaveBeenCalled();
  });
});
