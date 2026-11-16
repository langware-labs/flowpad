/**
 * FLOWPAD-2368: a deployed agent's box is signed in to the hub as its Identity, which by design leaves
 * `cloudUser` (a person only) empty. The data source page's stream inbox gated its "Login required"
 * overlay on `cloudUser`, so the signed-in agent box was told to log in.
 */
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

const { apiClient, cloudManager, dataContext } = await import('@sdk');
const { StreamInboxView } = await import('@src/components/stream-inbox-view/StreamInboxView');

const AGENT_IDENTITY = {
  type: 'identity',
  id: 'a5380803-76a9-4e1e-8854-d1e5d0f308d3',
  name: 'Spora QA Bot',
  subject_typeid: 'agent-04f3ab7a-d33b-48c0-ae0e-6e61e181a343',
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.agent_identity_login.rules: FAILING? read this tag's rules before
//       editing — an agent Identity is signed in although cloudUser is null
// flowpad:endcapsule tag
describe("a data source's stream inbox on an agent's box", () => {
  it('asks to log in until the hub signs the box in as its agent Identity, then stops asking', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(null as never);
    vi.spyOn(apiClient, 'post').mockResolvedValue(null as never);
    render(<StreamInboxView sourceId="1eedfa10-bb0d-48cc-b3ae-57153bb8c298" embedded />, { wrapper: TooltipProvider });
    expect(screen.getByTestId('login-required-overlay')).toBeTruthy();

    // The box's bootstrap seed: signed in, no person, the agent's Identity as the principal.
    await act(() =>
      cloudManager.seedBootstrap({
        user: null,
        desktop_info: {
          cloud_url: 'https://hub.test',
          login: { status: 'logged_in', user: null, principal: AGENT_IDENTITY, reason: null },
        },
      } as never),
    );
    expect(dataContext.signedInAsIdentity).toBe(true);
    expect(dataContext.cloudUser).toBeNull();

    await waitFor(() => expect(screen.queryByTestId('login-required-overlay')).toBeNull());
  });
});
