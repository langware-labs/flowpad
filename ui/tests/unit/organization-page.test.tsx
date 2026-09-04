import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrganizationPage } from '@src/components/organization/organization-page';

/**
 * People & teams — the plain screen.
 *
 * Asserts the shape the research settled on (master–detail: structure tree left,
 * roster right) and, above all, that a simple user is not dropped into the graph:
 * the graph is offered as a named alternative, never as the default.
 */

// Rendered inside a router AND a query client: the roster pulls in navigation-aware pieces and the
// budgets section is react-query backed, and a component test should not be the thing that
// discovers that. Both providers are real in the app, so wrapping here matches the tree rather
// than mocking the page's own dependencies away.
const Providers = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

const render = (ui: React.ReactElement) => rtlRender(<Providers>{ui}</Providers>);

const ME = { user_id: 'me-id', email: 'me@example.com', name: 'Me', role: 'owner', type: 'user' };
const A_PERSON = { user_id: 'p-1', email: 'ann@example.com', name: 'Ann', role: 'member', type: 'user' };
const A_TEAM = { user_id: null, id: 'team-1', name: 'Class 3B', role: 'member', type: 'team' };

const availabilityMock = vi.fn(() => ({ available: true, reason: 'available' }));
const orgsMock = vi.fn(() => ({ data: [{ id: 'org-1', name: 'Springfield High' }], isLoading: false }));
const membersMock = vi.fn();
const navigationMock = vi.hoisted(() => ({ openPage: vi.fn() }));

vi.mock('@src/components/conversation/useLocalUser', () => ({
  useLocalUser: () => ({ localUser: { id: 'me-id', email: 'me@example.com' }, updateName: vi.fn() }),
}));
vi.mock('@src/hooks/use-membership-availability', () => ({
  useMembershipAvailability: () => availabilityMock(),
}));
vi.mock('@src/hooks/entity-hooks/useEntitiesQuery', () => ({
  useEntitiesQuery: () => orgsMock(),
}));
vi.mock('@src/hooks/use-members', () => ({
  useMembers: (...args: unknown[]) => membersMock(...args),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: navigationMock }),
}));

const h = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  createChildTeam: vi.fn(),
}));
vi.mock('@src/components/organization/create-organization', () => ({
  createOrganization: (...args: unknown[]) => h.createOrganization(...args),
}));
vi.mock('@src/components/organization/create-child-team', () => ({
  createChildTeam: (...args: unknown[]) => h.createChildTeam(...args),
}));

function mockRoster(members: unknown[]) {
  membersMock.mockReturnValue({
    members,
    ready: true,
    updating: false,
    stale: false,
    available: true,
    reason: 'available',
    refresh: vi.fn(),
    removeMember: vi.fn(),
    setRole: vi.fn(),
  });
}

describe('OrganizationPage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    availabilityMock.mockReturnValue({ available: true, reason: 'available' });
    orgsMock.mockReturnValue({ data: [{ id: 'org-1', name: 'Springfield High' }], isLoading: false });
  });

  it('opens on the roster, with the graph offered as a named alternative', () => {
    mockRoster([ME, A_PERSON, A_TEAM]);
    render(<OrganizationPage />);

    // The org is selected without the user having to pick anything.
    expect(screen.getByTestId('org-detail')).toBeTruthy();
    expect(screen.getAllByText('Springfield High').length).toBeGreaterThan(0);
    // The graph is a button you can choose — not where you landed.
    expect(screen.getByTestId('org-open-graph')).toBeTruthy();
  });

  it('subscribes to the org query once, not once per render', () => {
    // Regression: the request was built inline, so every render produced a new
    // QueryRequest -> useEntitiesQuery re-subscribed -> its subscribe callback
    // re-rendered immediately -> "Maximum update depth exceeded", and the screen
    // never painted. Identity has to be stable across renders.
    mockRoster([ME]);
    const { rerender } = render(<OrganizationPage />);
    const callsAfterFirst = orgsMock.mock.calls.length;
    rerender(
      <Providers>
        <OrganizationPage />
      </Providers>,
    );
    // Re-rendering may call the hook again, but it must never spiral: a handful
    // of calls is a render, thousands is the loop this pins shut.
    expect(orgsMock.mock.calls.length).toBeLessThan(callsAfterFirst + 10);
  });

  it('separates people from teams instead of one mixed list', () => {
    // A team confers its role on everyone inside it; a person does not. Mixing
    // them in one table is what made the first version hard to read.
    mockRoster([ME, A_PERSON, A_TEAM]);
    render(<OrganizationPage />);

    expect(screen.getByText('People')).toBeTruthy();
    expect(screen.getByText('Teams in this organization')).toBeTruthy();
    expect(screen.getByText('Ann')).toBeTruthy();
    // Twice on purpose: once as a branch of the structure tree, once as a row of
    // this organization's Teams — the same team seen from two useful angles.
    expect(screen.getAllByText('Class 3B').length).toBe(2);
  });

  it('shows the structure tree with an expand control', () => {
    mockRoster([ME, A_TEAM]);
    render(<OrganizationPage />);

    expect(screen.getByText('Structure')).toBeTruthy();
    expect(screen.getAllByTestId('org-tree-node').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('org-tree-toggle').length).toBeGreaterThan(0);
  });

  it('offers invite and create to an admin, and neither to a plain member', () => {
    mockRoster([ME, A_PERSON]);
    const { unmount } = render(<OrganizationPage />);
    expect(screen.getByTestId('org-invite-open')).toBeTruthy();
    expect(screen.getByTestId('org-create-team')).toBeTruthy();
    unmount();

    mockRoster([{ ...ME, role: 'member' }, A_PERSON]);
    render(<OrganizationPage />);
    expect(screen.queryByTestId('org-invite-open')).toBeNull();
    expect(screen.queryByTestId('org-create-team')).toBeNull();
  });

  it('explains itself when there is nothing to show', () => {
    orgsMock.mockReturnValue({ data: [], isLoading: false });
    mockRoster([]);
    render(<OrganizationPage />);
    expect(screen.getByText('No organization yet')).toBeTruthy();
  });

  it('says so in Local mode rather than failing to load', () => {
    availabilityMock.mockReturnValue({ available: false, reason: 'local' });
    mockRoster([]);
    render(<OrganizationPage />);
    expect(screen.getByText('Not available in Local mode')).toBeTruthy();
  });

  it('creates a new organization from the header form', async () => {
    h.createOrganization.mockResolvedValue({ type: 'organization', id: 'org-new' });
    mockRoster([ME]);
    render(<OrganizationPage />);

    fireEvent.click(screen.getByTestId('org-create-open'));
    fireEvent.change(screen.getByTestId('org-create-name'), { target: { value: 'Acme Inc' } });
    fireEvent.click(screen.getByTestId('org-create-submit'));

    await waitFor(() => expect(h.createOrganization).toHaveBeenCalledWith('Acme Inc'));
  });

  it('does nothing when the organization name is left blank', () => {
    mockRoster([ME]);
    render(<OrganizationPage />);

    fireEvent.click(screen.getByTestId('org-create-open'));
    fireEvent.click(screen.getByTestId('org-create-submit'));

    expect(h.createOrganization).not.toHaveBeenCalled();
  });

  it('creates a team under the organization from the roster panel', async () => {
    h.createChildTeam.mockResolvedValue({ type: 'team', id: 'team-new' });
    mockRoster([ME]);
    render(<OrganizationPage />);

    fireEvent.click(screen.getByTestId('org-create-team'));
    fireEvent.change(screen.getByTestId('org-create-team-name'), { target: { value: 'Platform' } });
    fireEvent.click(screen.getByTestId('org-create-team-submit'));

    await waitFor(() => expect(h.createChildTeam).toHaveBeenCalled());
    // Scoped under the currently selected organization, by NAME — not a bare string.
    expect(h.createChildTeam.mock.calls[0][1]).toBe('Platform');
  });
});
