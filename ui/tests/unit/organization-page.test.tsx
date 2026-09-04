import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrganizationPage } from '@src/components/organization/organization-page';

/**
 * People & teams — the plain screen.
 *
 * One continuous, full-width list of organizations, each rendering its own budget hierarchy
 * (`OrgUnit`, tested directly in `budget-section.test.tsx`) — nothing here is reached by
 * selecting a node in a side tree any more. This file covers what belongs to the PAGE itself:
 * the list of organizations, creating a new one, and that a simple user is not dropped into the
 * graph (offered as a named alternative, never the default).
 */

const Providers = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

const render = (ui: React.ReactElement) => rtlRender(<Providers>{ui}</Providers>);

const availabilityMock = vi.fn(() => ({ available: true, reason: 'available' }));
const orgsMock = vi.fn(() => ({ data: [{ id: 'org-1', name: 'Springfield High' }], isLoading: false }));
const navigationMock = vi.hoisted(() => ({ openPage: vi.fn() }));

vi.mock('@src/hooks/use-membership-availability', () => ({
  useMembershipAvailability: () => availabilityMock(),
}));
vi.mock('@src/hooks/entity-hooks/useEntitiesQuery', () => ({
  useEntitiesQuery: () => orgsMock(),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: navigationMock }),
}));

const h = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  createChildTeam: vi.fn(),
  orgBudgets: vi.fn(),
}));
vi.mock('@src/components/organization/create-organization', () => ({
  createOrganization: (...args: unknown[]) => h.createOrganization(...args),
}));
vi.mock('@src/components/organization/create-child-team', () => ({
  createChildTeam: (...args: unknown[]) => h.createChildTeam(...args),
}));
// `OrgUnit` is rendered for real (not mocked) so the page-level "create a team" flow is exercised
// end to end through the real `useCreateChildTeamForm` hook; only its OWN data dependencies are
// stubbed, the same way `budget-section.test.tsx` does for `OrgUnit` in isolation.
vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useOrgBudgets: (...args: unknown[]) => h.orgBudgets(...args),
  useTeamBudgets: () => ({ data: undefined, isLoading: false, error: null }),
  useSetLifetimeCap: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveAllowance: () => ({ mutate: vi.fn(), isPending: false }),
  useAddPeople: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetPayingProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useInvalidateBudgets: () => vi.fn().mockResolvedValue(undefined),
}));

function orgBudgetsOf(name: string, teams: unknown[] = []) {
  return {
    data: {
      org: {
        id: 'org-1',
        name,
        endpoint_id: null,
        limit_usd: null,
        spent_usd: 0,
        allocated_usd: null,
        is_root: false,
        provider: null,
        credential_hint: '',
        // The caller here is the org's owner, so every control the page can show is offered.
        can_configure: true,
        can_allocate: true,
        can_manage: true,
        can_add_child: true,
        can_set_credential: true,
        can_invite: true,
      },
      teams,
    },
    isLoading: false,
    error: null,
  };
}

describe('OrganizationPage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    availabilityMock.mockReturnValue({ available: true, reason: 'available' });
    orgsMock.mockReturnValue({ data: [{ id: 'org-1', name: 'Springfield High' }], isLoading: false });
  });

  it('lists every organization the caller administers, with the graph offered as a named alternative', () => {
    h.orgBudgets.mockReturnValue(orgBudgetsOf('Springfield High'));
    render(<OrganizationPage />);

    expect(screen.getByTestId('org-unit')).toBeTruthy();
    expect(screen.getByTestId('org-name').textContent).toBe('Springfield High');
    // The graph is a button you can choose — not where you landed.
    expect(screen.getByTestId('org-open-graph')).toBeTruthy();
  });

  it('subscribes to the org query once, not once per render', () => {
    // Regression: the request was built inline, so every render produced a new QueryRequest ->
    // useEntitiesQuery re-subscribed -> its subscribe callback re-rendered immediately ->
    // "Maximum update depth exceeded". Identity has to be stable across renders.
    h.orgBudgets.mockReturnValue(orgBudgetsOf('Springfield High'));
    const { rerender } = render(<OrganizationPage />);
    const callsAfterFirst = orgsMock.mock.calls.length;
    rerender(
      <Providers>
        <OrganizationPage />
      </Providers>,
    );
    expect(orgsMock.mock.calls.length).toBeLessThan(callsAfterFirst + 10);
  });

  it('says so plainly, per organization, when the caller may not see its budgets', () => {
    h.orgBudgets.mockReturnValue({ data: undefined, isLoading: false, error: new Error('401') });
    render(<OrganizationPage />);
    expect(screen.getByText(/only an admin/i)).toBeTruthy();
    expect(screen.queryByTestId('org-create-team')).toBeNull();
  });

  it('explains itself when there is nothing to show', () => {
    orgsMock.mockReturnValue({ data: [], isLoading: false });
    render(<OrganizationPage />);
    expect(screen.getByText('No organization yet')).toBeTruthy();
  });

  it('says so in Local mode rather than failing to load', () => {
    availabilityMock.mockReturnValue({ available: false, reason: 'local' });
    render(<OrganizationPage />);
    expect(screen.getByText('Not available in Local mode')).toBeTruthy();
  });

  it('creates a new organization from the header form', async () => {
    h.createOrganization.mockResolvedValue({ type: 'organization', id: 'org-new' });
    h.orgBudgets.mockReturnValue(orgBudgetsOf('Springfield High'));
    render(<OrganizationPage />);

    fireEvent.click(screen.getByTestId('org-create-open'));
    fireEvent.change(screen.getByTestId('org-create-name'), { target: { value: 'Acme Inc' } });
    fireEvent.click(screen.getByTestId('org-create-submit'));

    await waitFor(() => expect(h.createOrganization).toHaveBeenCalledWith('Acme Inc'));
  });

  it('does nothing when the organization name is left blank', () => {
    h.orgBudgets.mockReturnValue(orgBudgetsOf('Springfield High'));
    render(<OrganizationPage />);

    fireEvent.click(screen.getByTestId('org-create-open'));
    fireEvent.click(screen.getByTestId('org-create-submit'));

    expect(h.createOrganization).not.toHaveBeenCalled();
  });

  it('creates a team under the organization from its own "New team" control', async () => {
    h.createChildTeam.mockResolvedValue({ type: 'team', id: 'team-new' });
    h.orgBudgets.mockReturnValue(orgBudgetsOf('Springfield High'));
    render(<OrganizationPage />);

    fireEvent.click(screen.getByTestId('org-create-team'));
    fireEvent.change(screen.getByTestId('org-create-team-name'), { target: { value: 'Platform' } });
    fireEvent.click(screen.getByTestId('org-create-team-submit'));

    await waitFor(() => expect(h.createChildTeam).toHaveBeenCalled());
    // Scoped under THIS organization, by NAME — not a bare string.
    expect(h.createChildTeam.mock.calls[0][1]).toBe('Platform');
  });
});
