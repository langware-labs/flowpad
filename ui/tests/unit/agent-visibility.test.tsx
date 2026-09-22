/**
 * The agent visibility panel: a prominent Share button (email invite, enabled once published),
 * once published, a copyable launch link pointed at the hub, and a public-access toggle that reads
 * the visitor audience's role on the hub row and grants or revokes it.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/react/hooks', async (original) => ({
  ...(await original<object>()),
  useAuth: () => ({ currentUser: { id: 'u1', email: 'me@example.com' } }),
}));
// The picker needs auth context this test doesn't stand up; only its presence matters here.
vi.mock('@src/components/contact-picker/ContactPicker', () => ({ ContactPicker: () => null }));
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({ AddressBookButton: () => null }));

const { Agent, cloudManager, dataManager } = await import('@sdk');
const { AgentVisibilitySection } = await import('@src/components/assets/editor/agent-profile/AgentVisibilitySection');
const { TooltipProvider } = await import('@src/components/ui/tooltip');
type AgentVersionState = import('@sdk').AgentVersionState;

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const agent = () => new Agent({ id: AGENT_ID, name: 'q' });

const PUBLISHED: AgentVersionState = { published: true, published_commit: 'deadbeef', has_repo: true, pending_changes: 0 };
const UNPUBLISHED: AgentVersionState = { published: false, published_commit: '', has_repo: true, pending_changes: 1 };
const HUB = 'https://staging.flowpad.ai';

const tree = (version: AgentVersionState | null) => (
  <TooltipProvider>
    <AgentVisibilitySection agent={agent()} version={version} />
  </TooltipProvider>
);

beforeEach(() => {
  // No hub in the unit tier: the public-access read is refused unless a test fakes the hub.
  vi.spyOn(dataManager, 'callAction').mockRejectedValue(hubError(503, 'no hub in the unit tier'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AgentVisibilitySection', () => {
  it('disables Share until the agent is published — the invite needs a hub row', () => {
    render(tree(UNPUBLISHED));

    const share = screen.getByTestId('agent-share-with-people');
    expect(share).toHaveTextContent('Share');
    expect(share).toBeDisabled();
  });

  it('opens the share-by-email dialog once published', () => {
    render(tree(PUBLISHED));

    expect(screen.queryByTestId('share-agent-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-share-with-people'));

    expect(screen.getByTestId('share-agent-dialog')).toBeInTheDocument();
  });

  it('shows the hub launch link and its share hint only once published', () => {
    vi.spyOn(cloudManager, 'cloudAppUrl', 'get').mockReturnValue(HUB);

    const { rerender } = render(tree(UNPUBLISHED));
    expect(screen.queryByTestId('agent-launch-link')).not.toBeInTheDocument();

    rerender(tree(PUBLISHED));
    expect(screen.getByTestId('agent-launch-link')).toHaveTextContent(`${HUB}/launch?agent=${AGENT_ID}`);
    expect(screen.getByTestId('agent-launch-link-hint')).toHaveTextContent('Share the agent with someone first');
  });

  it('omits the launch link while the version is unknown', () => {
    vi.spyOn(cloudManager, 'cloudAppUrl', 'get').mockReturnValue(HUB);

    render(tree(null));

    expect(screen.queryByTestId('agent-launch-link')).not.toBeInTheDocument();
  });

  it('omits the launch link when the hub app url is not yet known, even once published', () => {
    vi.spyOn(cloudManager, 'cloudAppUrl', 'get').mockReturnValue('');

    render(tree(PUBLISHED));

    expect(screen.queryByTestId('agent-launch-link')).not.toBeInTheDocument();
  });

  it('neither reads nor offers public access until the agent is published — public access needs a hub row', () => {
    const hub = fakeHub(null);
    const { rerender } = render(tree(UNPUBLISHED));
    rerender(tree(null));

    expect(screen.queryByTestId('agent-public-access')).not.toBeInTheDocument();
    expect(hub.calls).toEqual([]);
  });

  it('reads the visitor audience and offers Set public when the agent is private', async () => {
    const hub = fakeHub(null);
    render(tree(PUBLISHED));

    await waitFor(() => expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Set public'));
    expect(hub.calls).toEqual([{ method: 'GET', url: AUDIENCE_URL, body: undefined }]);
    expect(hub.reflected).toBe(true);
  });

  it('makes the agent public, then flips the button to Remove public access', async () => {
    const hub = fakeHub(null);
    render(tree(PUBLISHED));
    await waitFor(() => expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Set public'));

    fireEvent.click(screen.getByTestId('agent-public-access'));

    await waitFor(() => expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Remove public access'));
    expect(hub.calls[1]).toEqual({ method: 'PUT', url: AUDIENCE_URL, body: { role: 'anonymous_viewer' } });
  });

  it('offers Remove public access for an already-public agent, and revokes it on click', async () => {
    const hub = fakeHub('anonymous_viewer');
    render(tree(PUBLISHED));
    await waitFor(() => expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Remove public access'));

    fireEvent.click(screen.getByTestId('agent-public-access'));

    await waitFor(() => expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Set public'));
    expect(hub.calls[1]).toEqual({ method: 'DELETE', url: AUDIENCE_URL, body: undefined });
  });

  it('shows the agent as private when public access cannot be read — not the owner, or a hub without the API', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockRejectedValue(hubError(403, 'Only the owner can change public access'));
    render(tree(PUBLISHED));

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Set public');
  });

  it('ignores a public-access answer without an audience — a hub before the API returns the agent row', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ type: 'agent', id: AGENT_ID, role: 'owner' });
    render(tree(PUBLISHED));

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Set public');
  });

  it('keeps the current state when a change is refused, so the owner can retry', async () => {
    const hub = fakeHub(null, { failWrites: true });
    render(tree(PUBLISHED));
    await waitFor(() => expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Set public'));

    fireEvent.click(screen.getByTestId('agent-public-access'));

    await waitFor(() => expect(hub.calls).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('agent-public-access')).not.toBeDisabled());
    expect(screen.getByTestId('agent-public-access')).toHaveTextContent('Set public');
  });
});

const AUDIENCE_URL = `agent/${AGENT_ID}/access/public/visitor`;

/** Shaped like an AxiosError: the hub's explanation rides on `response.data`. */
function hubError(status: number, detail: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { detail } },
  });
}

/**
 * The hub's `access/public/visitor` grant, in memory: GET reads it, PUT sets it, DELETE clears it.
 * Records each call's method, the audience path and its body.
 */
function fakeHub(initialRole: string | null, { failWrites = false } = {}) {
  let role = initialRole;
  const hub = { calls: [] as { method: string; url: string; body: unknown }[], reflected: true };
  vi.spyOn(dataManager, 'callAction').mockImplementation((info) => {
    const url = info.fullActionUrl.slice(info.fullActionUrl.indexOf('agent/'));
    const body = info.method === 'PUT' ? info.bodyParameters : undefined;
    hub.calls.push({ method: info.method, url, body });
    hub.reflected &&= info.hubReflect;
    if (info.method !== 'GET') {
      if (failWrites) return Promise.reject(hubError(400, 'refused'));
      role = info.method === 'PUT' ? (info.bodyParameters as { role: string }).role : null;
    }
    return Promise.resolve({ audience: 'visitor', role });
  });
  return hub;
}
