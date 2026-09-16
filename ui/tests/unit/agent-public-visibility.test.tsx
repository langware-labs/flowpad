/**
 * "Make agent publicly visible" — the agent panel's one call into the hub's `set_public`.
 *
 * What is pinned is the wire shape (the action, the `anonymous` word, and that it is reflected to
 * the hub rather than resolved by a local backend) and the button's state around it. The hub's own
 * authorization and stamping are covered hub-side (`test_set_public_authorization.py`).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouterWrapper } from '../utils/router-test-utils';

const mocks = vi.hoisted(() => ({ error: vi.fn() }));
// Delegate rather than hand over `mocks.error` itself: the factory runs once, and each test swaps in
// a fresh spy — a captured reference would keep pointing at the first one.
vi.mock('@src/notifications', () => ({
  notify: { error: (...args: unknown[]) => mocks.error(...args) },
  dismiss: vi.fn(),
}));

const { Agent, dataManager } = await import('@sdk');
const { AgentPublicVisibilitySection } =
  await import('@src/components/assets/editor/agent-profile/AgentPublicVisibilitySection');
const { TooltipProvider } = await import('@src/components/ui/tooltip');

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const agent = (over: Record<string, unknown> = {}) => new Agent({ id: AGENT_ID, name: 'q', remote: true, ...over });

// ShareButton renders a Tooltip (needs a TooltipProvider), and opening its dialog calls
// useDockNavigation (needs a Router) — neither is otherwise on this page's own tree.
const RouterWrapper = createRouterWrapper('/');
const renderSection = (props: { agent: InstanceType<typeof Agent> }) =>
  render(
    <RouterWrapper>
      <TooltipProvider>
        <AgentPublicVisibilitySection {...props} />
      </TooltipProvider>
    </RouterWrapper>,
  );

// The hub's answer for a published agent: not public, unless a test says otherwise.
let hubPermissions: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.error = vi.fn();
  hubPermissions = vi.spyOn(Agent.prototype, 'fetchPermissions').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AgentPublicVisibilitySection', () => {
  it('calls set_public with anonymous, reflected to the hub, and then reads as public', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ public: 'anonymous' });

    renderSection({ agent: agent() });
    const button = screen.getByTestId('agent-make-public');
    expect(button).toHaveTextContent('Make agent publicly visible');
    expect(screen.getByTestId('agent-public-consequence')).toHaveTextContent('even without signing in');

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveTextContent('Agent is publicly visible'));
    expect(button).toBeDisabled();
    expect(call).toHaveBeenCalledTimes(1);
    const info = call.mock.calls[0][0];
    expect(info.fullActionUrl).toContain(`agent/${AGENT_ID}/set_public`);
    expect(info.bodyParameters).toEqual({ public: 'anonymous' });
    expect(info.hubReflect).toBe(true);
  });

  it('reads the hub permissions of a published agent and shows it as public, with nothing to click', async () => {
    const fetch = vi.spyOn(Agent.prototype, 'fetchPermissions').mockResolvedValue(['anonymous_viewer']);
    const call = vi.spyOn(dataManager, 'callAction');

    renderSection({ agent: agent() });

    const button = screen.getByTestId('agent-make-public');
    await waitFor(() => expect(button).toHaveTextContent('Agent is publicly visible'));
    expect(button).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
  });

  it('does not ask the hub about an unpublished agent, and offers nothing to click', () => {
    const fetch = vi.spyOn(Agent.prototype, 'fetchPermissions');
    const call = vi.spyOn(dataManager, 'callAction');

    renderSection({ agent: agent({ remote: false }) });

    const button = screen.getByTestId('agent-make-public');
    expect(button).toHaveTextContent('Publish this agent to share it');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetch).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('reports a refused call and leaves the button usable', async () => {
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(new Error('agent cannot be made public'));

    renderSection({ agent: agent() });
    const button = screen.getByTestId('agent-make-public');
    fireEvent.click(button);

    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    expect((mocks.error.mock.calls[0][0] as { message: string }).message).toContain('agent cannot be made public');
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveTextContent('Make agent publicly visible');
  });

  it('offers a Share button that opens the contact-first share dialog, independent of publish state', () => {
    renderSection({ agent: agent({ remote: false }) });

    fireEvent.click(screen.getByTestId('agent-share-with-people'));

    expect(screen.getByTestId('share-to-conversation-dialog')).toBeInTheDocument();
  });
});

describe('Agent.fetchPermissions', () => {
  it('GETs the agent with expand=permissions, reflected to the hub, and reads the roles', async () => {
    hubPermissions.mockRestore(); // the method under test, not a stub
    const call = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue({ id: AGENT_ID, expand: { roles: ['anonymous_viewer'] } });

    const roles = await agent().fetchPermissions();

    const info = call.mock.calls[0][0];
    expect(info.method).toBe('GET');
    expect(info.hubReflect).toBe(true);
    expect(info.fullActionUrl).toContain(`agent/${AGENT_ID}?expand=permissions`);
    expect(roles).toEqual(['anonymous_viewer']);
  });
});
