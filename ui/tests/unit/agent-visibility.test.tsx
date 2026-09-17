/**
 * The agent visibility panel: a prominent Share button (email invite, enabled once published) and,
 * once published, a copyable launch link pointed at the hub.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/react/hooks', async (original) => ({
  ...(await original<object>()),
  useAuth: () => ({ currentUser: { id: 'u1', email: 'me@example.com' } }),
}));
// The picker needs auth context this test doesn't stand up; only its presence matters here.
vi.mock('@src/components/contact-picker/ContactPicker', () => ({ ContactPicker: () => null }));
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({ AddressBookButton: () => null }));

const { Agent, cloudManager } = await import('@sdk');
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
});
