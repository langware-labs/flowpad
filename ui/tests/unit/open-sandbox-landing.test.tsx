/**
 * `/compute_node/<id>` — the invitation landing, and the branch it was missing.
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
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** What the addressed GET answers with: a node, null (no such box), or a throw. */
  getById: vi.fn(),
  launchSandbox: vi.fn(),
  steps: [] as unknown[],
  /** Invitations addressed to the signed-in user, as `pending` would return them. */
  pending: vi.fn(),
  acceptOnHub: vi.fn(),
  /** Whether the SDK reports a live cloud session. */
  loggedIn: true,
  loginUrl: vi.fn((cb: string) => `https://hub.test/api/v1/login?target_path=${encodeURIComponent(cb)}`),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchPendingInvitations: () => mocks.pending(),
    acceptInvitationOnHub: (id: string) => mocks.acceptOnHub(id),
    cloudManager: {
      ...(actual.cloudManager as object),
      get isLoggedIn() {
        return mocks.loggedIn;
      },
    },
    navigator: { getLoginWithCallbackUrl: (cb: string) => mocks.loginUrl(cb) },
  };
});

vi.mock('@src/hooks/use-sandboxes', async (importOriginal) => {
  // `isLaunched` and `workspaceServiceUrl` stay REAL: they are the contract with
  // the hub (one field, one route), and stubbing them would leave this test
  // asserting its own opinion of when a box needs launching.
  //
  // `sandboxes`/`isLoading` are deliberately NOT provided: the page must not read
  // the list again. A disabled react-query reports `isLoading: false` with no
  // data, which made "still loading" indistinguishable from "no such box" — the
  // bug this file now pins.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSandboxes: () => ({ launchSandbox: mocks.launchSandbox, steps: mocks.steps }),
  };
});

const { ComputeNode } = await import('@sdk');
vi.spyOn(ComputeNode as unknown as { getById: unknown }, 'getById' as never).mockImplementation(((id: string) =>
  mocks.getById(id)) as never);

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
  mocks.steps = [];
  mocks.launchSandbox = vi.fn();
  mocks.getById = vi.fn().mockResolvedValue(null);
  mocks.pending = vi.fn().mockResolvedValue([]);
  mocks.acceptOnHub = vi.fn().mockResolvedValue(undefined);
  mocks.loggedIn = true;
  mocks.loginUrl = vi.fn((cb: string) => `https://hub.test/api/v1/login?target_path=${encodeURIComponent(cb)}`);
  // jsdom's real `location.assign` is unimplemented and logs a "not implemented"
  // error instead of navigating — the same swap `cloud-manager-hub-identity` makes.
  assign = vi.fn();
  delete (window as unknown as { location?: Location }).location;
  (window as unknown as { location: Partial<Location> }).location = {
    origin: originalLocation.origin,
    href: originalLocation.href,
    pathname: `/compute_node/${NODE_ID}`,
    search: '',
    assign,
  };
});

afterEach(() => {
  cleanup();
  (window as unknown as { location: Location }).location = originalLocation;
});

/**
 * Rendered through a real `<Route path="compute_node/:nodeId">`, not bare.
 *
 * The id arrives via `useParams` now, and a bare render supplies no params at
 * all — the page would read an empty id and take the "this link is missing the
 * sandbox" exit, passing nothing and proving nothing.
 */
function renderLanding(nodeId = NODE_ID) {
  return render(
    <MemoryRouter initialEntries={[`/compute_node/${nodeId}`]}>
      <Routes>
        <Route path="compute_node/:nodeId" element={<OpenSandboxLanding />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('compute_node landing', () => {
  it('opens a launched sandbox without touching the launch path', async () => {
    mocks.getById.mockResolvedValue(node({ node_provider_id: 'e2b-sandbox-1' }));

    renderLanding();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    // The box has a VM. Re-running setup on it would overwrite `node_provider_id`
    // and orphan the machine it names.
    expect(mocks.launchSandbox).not.toHaveBeenCalled();
  });

  it('launches a sandbox that was shared before it was ever started, then opens it', async () => {
    mocks.getById.mockResolvedValue(node());
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
    mocks.getById.mockResolvedValue(node());
    mocks.steps = [{ id: 'launch', label: 'Starting the sandbox', status: 'loading' }];
    // Never settles: the assertion is about what is on screen DURING the launch.
    mocks.launchSandbox.mockReturnValue(new Promise(() => {}));

    renderLanding();

    await waitFor(() => expect(screen.getByTestId('open-sandbox-launching')).toBeTruthy());
    expect(screen.getByTestId('open-sandbox-launch-steps')).toBeTruthy();
    expect(screen.getByText('Starting the sandbox')).toBeTruthy();
  });

  it('names the owner when the recipient holds a plain share', async () => {
    mocks.getById.mockResolvedValue(node());
    // `ops` resolves for `owner` and nobody else, so an `admin` share — which is
    // what the dialog grants without the transfer checkbox — gets exactly this.
    mocks.launchSandbox.mockRejectedValue({ response: { status: 403 } });

    renderLanding();

    const message = await screen.findByTestId('open-sandbox-error');
    expect(message.textContent).toContain('only its owner can start it');
    // Nowhere to send them: the box has no VM, so the URL would 409.
    expect(assign).not.toHaveBeenCalled();
  });

  it('ASKS for the node instead of looking for it in a list', async () => {
    // The regression, reported from staging: this page used to find the node in
    // `useSandboxes().sandboxes`, gated on `enabled: !!user`. A DISABLED
    // react-query reports `isLoading: false` with no data, so before auth
    // resolved "still loading" and "loaded, and no such box" were the same
    // observation — and the page took the second one, redirected to
    // `open-service`, and produced the exact 409 it exists to prevent. Arriving
    // from a sign-in round trip, which is what an invitation does, made that the
    // common path.
    //
    // An addressed GET has no such ambiguity: it answers, or it fails.
    mocks.getById.mockResolvedValue(node());

    renderLanding();

    await waitFor(() => expect(mocks.getById).toHaveBeenCalledWith(NODE_ID));
    await waitFor(() => expect(mocks.launchSandbox).toHaveBeenCalledTimes(1));
  });

  it('does not decide anything while the node is still being fetched', async () => {
    // Never settles. Redirecting here would be the old bug in a new place:
    // acting on the absence of an answer rather than on an answer.
    mocks.getById.mockReturnValue(new Promise(() => {}));

    renderLanding();

    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.launchSandbox).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls through to the hub for a node it cannot see', async () => {
    // A definitive "no such box": the hub authorizes this route, and its 403/404
    // is a better answer than a guess made here.
    mocks.getById.mockResolvedValue(null);

    renderLanding();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    expect(mocks.launchSandbox).not.toHaveBeenCalled();
  });

  it('falls through to the hub when the fetch itself fails', async () => {
    // 401 from a session that expired mid-flight, or an unreachable hub. Both are
    // the hub's to explain, and both must NOT read as "this box does not exist".
    mocks.getById.mockRejectedValue({ response: { status: 401 } });

    renderLanding();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    expect(mocks.launchSandbox).not.toHaveBeenCalled();
  });
});

/**
 * ONE LINK for share and for handover.
 *
 * There used to be two, with different powers: the emailed link performed the
 * handover, the pasted one could only be followed after it. Sending someone the
 * wrong one produced a "Wrong account" screen naming a problem they did not have
 * — they were signed in correctly and simply had no role yet.
 *
 * So a refusal from the node fetch is not forwarded blindly. It means "no role on
 * this node", and the likeliest reason to be standing on a sandbox's URL with no
 * role is an invitation waiting to be accepted.
 */
describe('compute_node landing — accepting the invitation', () => {
  const refused = { response: { status: 401 } };
  const invite = (over: Record<string, unknown> = {}) => ({
    id: 'inv-1',
    target_type: 'compute_node',
    target_id: NODE_ID,
    ...over,
  });

  it('accepts the pending invitation for THIS box, then carries on', async () => {
    mocks.getById.mockRejectedValueOnce(refused).mockResolvedValueOnce(node());
    mocks.pending.mockResolvedValue([invite()]);
    mocks.launchSandbox.mockResolvedValue(node({ node_provider_id: 'e2b-1' }));

    renderLanding();

    await waitFor(() => expect(mocks.acceptOnHub).toHaveBeenCalledWith('inv-1'));
    // Re-asked AFTER the accept: the first answer was "you have no role", and
    // the accept is what changes it. Acting on the stale refusal would strand
    // the recipient on the hub route that cannot launch.
    await waitFor(() => expect(mocks.getById).toHaveBeenCalledTimes(2));
    // …and then the ordinary never-launched path runs, unchanged.
    await waitFor(() => expect(mocks.launchSandbox).toHaveBeenCalledTimes(1));
  });

  it('accepts only the invitation addressed to the box in the URL', async () => {
    // Matched on the TARGET, never on position. Accepting whichever invitation
    // happened to be first would grant a role on a machine nobody asked about.
    mocks.getById.mockRejectedValueOnce(refused).mockResolvedValueOnce(node());
    mocks.pending.mockResolvedValue([
      invite({ id: 'inv-other', target_id: '99999999-2222-4333-8444-555555555555' }),
      invite({ id: 'inv-mine' }),
    ]);
    mocks.launchSandbox.mockResolvedValue(node({ node_provider_id: 'e2b-1' }));

    renderLanding();

    await waitFor(() => expect(mocks.acceptOnHub).toHaveBeenCalledWith('inv-mine'));
    expect(mocks.acceptOnHub).toHaveBeenCalledTimes(1);
  });

  it('ignores an invitation to a different kind of thing', async () => {
    mocks.getById.mockRejectedValue(refused);
    mocks.pending.mockResolvedValue([invite({ target_type: 'project' })]);

    renderLanding();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    expect(mocks.acceptOnHub).not.toHaveBeenCalled();
  });

  it('falls through to the hub when nothing is waiting for them', async () => {
    // A genuine stranger. The hub renders the 403 — this page must not invent one.
    mocks.getById.mockRejectedValue(refused);
    mocks.pending.mockResolvedValue([]);

    renderLanding();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    expect(mocks.acceptOnHub).not.toHaveBeenCalled();
  });

  it('falls through when the accept itself fails', async () => {
    // Expired between the listing and the accept, or the hub went away. Either
    // way the hub explains it better than a sentence invented here.
    mocks.getById.mockRejectedValue(refused);
    mocks.pending.mockResolvedValue([invite()]);
    mocks.acceptOnHub.mockRejectedValue(new Error('gone'));

    renderLanding();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
  });

  it('says what it is doing while the handover runs', async () => {
    mocks.getById.mockRejectedValue(refused);
    mocks.pending.mockResolvedValue([invite()]);
    mocks.acceptOnHub.mockReturnValue(new Promise(() => {}));

    renderLanding();

    await waitFor(() => expect(screen.getByTestId('open-sandbox-accepting')).toBeTruthy());
  });
});

/**
 * ARRIVING SIGNED OUT.
 *
 * The other half of the same failure. `getById` answers 401 for two different
 * reasons — "missing or invalid token" and "has no roles" — and they need
 * opposite responses. Forwarding to `open-service` was the response to both, and
 * it is what made every unlaunched transfer dead-end: the hub builds the
 * post-login callback from the url that reached it, so forwarding first makes
 * `open-service` the return address, and the recipient comes back signed in and
 * holding the role to the one route that cannot launch a box.
 *
 * Reproduced on staging 2026-08-11 (node ea357cf5): 401 "missing or invalid
 * token" at 09:48:18, transfer completed at 09:48:28, 409 at 09:48:29.
 */
describe('compute_node landing — arriving signed out', () => {
  const refused = { response: { status: 401 } };

  it('sends them to sign in and BACK HERE, not to the hub route', async () => {
    mocks.loggedIn = false;
    mocks.getById.mockRejectedValue(refused);

    renderLanding();

    await waitFor(() => expect(mocks.loginUrl).toHaveBeenCalledTimes(1));
    const callback = new URL(mocks.loginUrl.mock.calls[0][0]);
    // The return address is this page — the one that can launch — carrying the
    // guard flag so a second failure does not bounce again.
    expect(callback.pathname).toBe(`/compute_node/${NODE_ID}`);
    expect(callback.searchParams.get('signed-in')).toBe('1');
    // And nothing was forwarded to the hub, which is what poisoned the callback.
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0][0]).not.toContain('open-service');
  });

  it('does not bounce a second time', async () => {
    // Back from the round trip and still refused: signing in was not the answer,
    // so hand over to the hub, which can say why.
    mocks.loggedIn = false;
    mocks.getById.mockRejectedValue(refused);

    render(
      <MemoryRouter initialEntries={[`/compute_node/${NODE_ID}?signed-in=1`]}>
        <Routes>
          <Route path="compute_node/:nodeId" element={<OpenSandboxLanding />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(assign).toHaveBeenCalledWith(workspaceServiceUrl(NODE_ID)));
    expect(mocks.loginUrl).not.toHaveBeenCalled();
  });

  it('still accepts the invitation when they DO have a session', async () => {
    // The signed-out branch must not swallow the case it sits in front of.
    mocks.loggedIn = true;
    mocks.loginUrl = vi.fn((cb: string) => `https://hub.test/api/v1/login?target_path=${encodeURIComponent(cb)}`);
    mocks.getById.mockRejectedValueOnce(refused).mockResolvedValueOnce(node());
    mocks.pending.mockResolvedValue([{ id: 'inv-1', target_type: 'compute_node', target_id: NODE_ID }]);
    mocks.launchSandbox.mockResolvedValue(node({ node_provider_id: 'e2b-1' }));

    renderLanding();

    await waitFor(() => expect(mocks.acceptOnHub).toHaveBeenCalledWith('inv-1'));
    expect(mocks.loginUrl).not.toHaveBeenCalled();
  });
});
