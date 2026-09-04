/**
 * What a SHARED organization looks like to the admin it was shared with.
 *
 * `budget-section.test.tsx` renders the same page for an OWNER, with every `can_*` true. This file
 * is the other caller, and the difference between the two is the whole feature: an admin runs the
 * organization's people and divides its money, while its total, its provider key and its name stay
 * with the owner.
 *
 * Every flag here comes off the hub's `budgets` payload as a policy answer about the caller —
 * `can_configure` / `can_allocate` on each pool and `can_manage` / `can_add_child` on each scope
 * entity, plus `can_set_credential` / `can_invite` on the organization. Nothing on this page derives permission from a role string,
 * which is why an admin's DERIVED standing on a budget row (resolved hub-side from the scope the
 * row hangs under) reaches the screen correctly at all.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const EP = (n: number) => `llm_endpoint-${UUID(n)}`;

const h = vi.hoisted(() => ({
  org: vi.fn(),
  team: vi.fn(),
  setCap: vi.fn(),
}));

vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useOrgBudgets: (...args: unknown[]) => h.org(...args),
  useTeamBudgets: (...args: unknown[]) => h.team(...args),
  useSetLifetimeCap: () => ({ mutate: h.setCap, isPending: false }),
  useRemoveAllowance: () => ({ mutate: vi.fn(), isPending: false }),
  useAddPeople: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetPayingProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useInvalidateBudgets: () => vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@src/components/token-plan/use-token-plan', () => ({
  useSetupScope: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@src/components/organization/use-create-child-team', () => ({
  useCreateChildTeamForm: () => ({
    open: false,
    setOpen: vi.fn(),
    name: '',
    setName: vi.fn(),
    busy: false,
    submit: vi.fn(),
  }),
}));
vi.mock('@src/components/organization/budgets/EndpointControls', () => ({
  EndpointControls: () => null,
}));

import { OrgUnit } from '@src/components/organization/budgets/BudgetSection';

/** An org shared with an admin: they may divide it and run its people, and nothing else. */
const sharedOrg = (over: Record<string, unknown> = {}) => ({
  id: UUID(1),
  name: 'Langware',
  endpoint_id: EP(1),
  limit_usd: 100,
  spent_usd: 12.5,
  spent_tokens: 4200,
  allocated_usd: 40,
  is_root: true,
  provider: 'anthropic',
  credential_hint: '****z9z9',
  can_configure: false, // the org's own total is the owner's
  can_allocate: false, // people are funded from their TEAM's pool, never straight off the org's
  can_manage: false, // rename / delete the organization
  can_add_child: true, // adding a team is the delegated job
  can_set_credential: false, // whose key pays
  can_invite: true, // running the people is what it was shared FOR
  ...over,
});

/** A team inside it. An org admin derives full `admin` on everything BELOW the org's own pool. */
const team = (over: Record<string, unknown> = {}) => ({
  id: UUID(4),
  name: 'Platform',
  endpoint_id: EP(5),
  limit_usd: 40,
  spent_usd: 5,
  spent_tokens: 900,
  allocated_usd: null,
  can_configure: true,
  can_allocate: true,
  can_manage: true,
  can_add_child: true,
  ...over,
});

function draw(org = sharedOrg(), teams = [team()]) {
  h.org.mockReturnValue({ data: { org, teams }, isLoading: false, error: null });
  h.team.mockReturnValue({ data: undefined, isLoading: false, error: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a shared organization, seen by its admin', () => {
  it('shows the org total but will not accept a new one', () => {
    draw();
    const total = screen.getByTestId<HTMLInputElement>('org-total-cap');
    // Shown, because they are being asked to divide it; disabled, because how much there is is not
    // theirs to answer.
    expect(total.value).toBe('100');
    expect(total.disabled).toBe(true);
  });

  it('renders the organization name as plain text, with no rename and no delete', () => {
    draw();
    expect(screen.getByTestId('org-name').tagName).toBe('SPAN');
    expect(screen.queryByTestId('org-delete')).toBeNull();
  });

  it('states which provider pays and that a key is set, without offering the key form', () => {
    draw();
    fireEvent.click(screen.getByTestId('org-settings-toggle'));
    expect(screen.getByTestId('org-root-owner-only')).toBeTruthy();
    expect(screen.getByTestId('org-root-hint').textContent).toContain('****z9z9');
    // The form the OWNER gets is absent entirely — not a disabled version of it.
    expect(screen.queryByTestId('org-root-provider')).toBeNull();
  });

  it('opens Advanced on the org row as a report: no Save', () => {
    draw();
    fireEvent.click(screen.getByTestId('org-advanced'));
    expect(screen.getByTestId('advanced-endpoint-dialog')).toBeTruthy();
    // Per-window ceilings and rate caps bound what the org may spend, so they follow its total.
    expect(screen.queryByTestId('advanced-save')).toBeNull();
  });

  it('still offers Share — running the people is the job the org was shared for', () => {
    draw();
    expect(screen.getByTestId('org-share-open')).toBeTruthy();
  });

  it('lets the admin set a team budget, which is the delegated job', () => {
    draw();
    const teamCap = screen.getByTestId<HTMLInputElement>(`team-cap-${UUID(4)}`);
    expect(teamCap.disabled).toBe(false);

    fireEvent.change(teamCap, { target: { value: '55' } });
    fireEvent.blur(teamCap);
    expect(h.setCap).toHaveBeenCalledWith(expect.objectContaining({ usd: 55 }), expect.anything());
  });

  it('refuses a team budget larger than the organization has left', () => {
    // $100 org, $40 already given out of which this team holds $40 -> $100 free for this team.
    draw();
    const teamCap = screen.getByTestId<HTMLInputElement>(`team-cap-${UUID(4)}`);

    fireEvent.change(teamCap, { target: { value: '101' } });
    fireEvent.blur(teamCap);

    expect(h.setCap).not.toHaveBeenCalled();
    expect(screen.getByTestId('money-box-over')).toBeTruthy();
  });

  it('offers no Share button when the hub says the caller may not manage members', () => {
    draw(sharedOrg({ can_invite: false }));
    expect(screen.queryByTestId('org-share-open')).toBeNull();
  });

  it('offers no "New team" to someone who may not create under the org', () => {
    // Its own policy question (`create`), not a reading of the org's budget rights — an admin holds
    // no `allocate` on the org pot at all, so gating this on that would have hidden it from the
    // person whose job it is.
    draw(sharedOrg({ can_add_child: false }));
    expect(screen.queryByTestId('org-create-team')).toBeNull();
  });

  it('still offers "New team", which is the admin\'s actual job', () => {
    draw();
    expect(screen.getByTestId('org-create-team')).toBeTruthy();
  });
});
