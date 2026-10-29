/**
 * What a SHARED organization looks like to the admin it was shared with.
 *
 * `budget-section.test.tsx` renders the same page for an OWNER, with every `can_*` true. This file
 * is the other caller: an admin runs the organization's people and divides its money, while its
 * total, its provider key and its name stay with the owner. Every flag comes off the hub's
 * `budgets` payload; nothing here derives permission from a role string.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const EP = (n: number) => `llm_endpoint-${UUID(n)}`;

const h = vi.hoisted(() => ({
  org: vi.fn(),
  team: vi.fn(),
  setCap: vi.fn(),
  removeAllowance: vi.fn(),
  removeMember: vi.fn(),
  entities: vi.fn(() => ({ data: [], isLoading: false })),
  save: vi.fn(),
  del: vi.fn(),
  getByTypeId: vi.fn(),
  invite: vi.fn(),
  copyToClipboard: vi.fn(),
  teamBudgets: vi.fn(),
  pool: vi.fn(() => null as unknown),
}));

vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  teamBudgetsKey: (teamId: string) => ['budgets', 'team', teamId],
  useOrgBudgets: (...args: unknown[]) => h.org(...args),
  useTeamBudgets: (...args: unknown[]) => h.team(...args),
  useSetLifetimeCap: () => ({ mutate: h.setCap, isPending: false }),
  useRemoveAllowance: () => ({ mutate: h.removeAllowance, isPending: false }),
  useRemoveTeamMember: () => ({ mutate: h.removeMember, isPending: false }),
  useAddPeople: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetPayingProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSwitchPayingProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useInvalidateBudgets: () => vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@src/hooks/entity-hooks/useEntitiesQuery', () => ({
  useEntitiesQuery: (...args: unknown[]) => h.entities(...args),
}));
vi.mock('@src/hooks/use-members', () => ({
  useMembers: () => ({ members: [], refresh: vi.fn() }),
}));
vi.mock('@src/components/conversation/useLocalUser', () => ({
  useLocalUser: () => ({ localUser: null, updateName: vi.fn() }),
}));
vi.mock('@src/components/llm-endpoints/use-llm-endpoints', () => ({
  useLlmEndpoint: () => h.pool(),
  useLlmEndpoints: () => ({ data: [], refetch: vi.fn() }),
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
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: {
      ...(actual.dataManager as object),
      save: h.save,
      delete: h.del,
      getByTypeId: h.getByTypeId,
      getByTypeIdFromCache: () => null,
    },
    budgetsService: { ...(actual.budgetsService as object), teamBudgets: h.teamBudgets },
    copyToClipboard: h.copyToClipboard,
  };
});
// `EndpointControls` has its own suite (endpoint-controls.test.tsx); here it only has to exist.
vi.mock('@src/components/organization/budgets/EndpointControls', () => ({
  EndpointControls: () => null,
}));
vi.mock('@src/components/organization/budgets/invite-to-team', () => ({
  inviteToTeamByEmail: (...args: unknown[]) => h.invite(...args),
}));

import { OrgView } from '@src/components/organization/tabs/OrgView';
import type { OrgTab } from '@src/components/organization/tabs/org-route';

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
  can_allocate: false,
  can_manage: false, // rename / delete the organization
  can_add_child: true, // adding a team is the delegated job
  can_set_credential: false, // whose key pays
  can_set_up_budget: false, // funding the org at all
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
  my_role: 'admin',
  member_count: 1,
  can_configure: true,
  can_allocate: true,
  can_manage: true,
  can_add_child: true,
  ...over,
});

const person = (over: Record<string, unknown> = {}) => ({
  endpoint_id: EP(2),
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  user_id: UUID(3),
  limit_usd: 50,
  spent_usd: 0,
  spent_tokens: 0,
  can_configure: true,
  can_remove: true,
  ...over,
});

function draw(
  tab: OrgTab,
  { org = sharedOrg(), teams = [team()], teamId = null as string | null, members = [] as unknown[] } = {},
) {
  h.org.mockReturnValue({ data: { org, teams, people: [] }, isLoading: false, error: null, refetch: vi.fn() });
  h.team.mockReturnValue({ data: { team: teams[0], members }, isLoading: false, error: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <OrgView
          orgId={UUID(1)}
          tab={tab}
          teamId={teamId}
          onTab={vi.fn()}
          onOpenTeam={vi.fn()}
          onCloseTeam={vi.fn()}
          onDeleted={vi.fn()}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Radix menus open on pointerdown, not click. */
function openMenu(testId: string) {
  const trigger = screen.getByTestId(testId);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.keyDown(trigger, { key: 'Enter' });
}

beforeEach(() => {
  h.teamBudgets.mockResolvedValue({ members: [] });
  h.pool.mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a shared organization, seen by its admin', () => {
  it('shows the org total but will not accept a new one', () => {
    draw('billing');
    const total = screen.getByTestId<HTMLInputElement>('org-total-cap');
    expect(total.value).toBe('100');
    expect(total.disabled).toBe(true);
  });

  it('renders the organization name as plain text, with no rename and no delete', () => {
    draw('general');
    expect(screen.getByTestId('org-name').tagName).toBe('SPAN');
    expect(screen.queryByTestId('org-delete')).toBeNull();
    expect(screen.queryByTestId('org-danger-zone')).toBeNull();
  });

  it('states which provider pays and that a key is set, without offering the key form', () => {
    draw('billing');
    expect(screen.getByTestId('org-root-owner-only')).toBeTruthy();
    expect(screen.getByTestId('org-root-hint').textContent).toContain('****z9z9');
    expect(screen.queryByTestId('org-root-key')).toBeNull();
    expect(screen.queryByTestId('org-root-provider')).toBeNull();
  });

  it('offers no budget history on the org without can_configure', () => {
    draw('billing');
    expect(screen.queryByTestId('org-history')).toBeNull();
  });

  it('opens Advanced on the org as a report: no Save', () => {
    draw('billing');
    fireEvent.click(screen.getByTestId('org-advanced'));
    expect(screen.getByTestId('advanced-endpoint-dialog')).toBeTruthy();
    expect(screen.queryByTestId('advanced-save')).toBeNull();
  });

  it('still offers Share — running the people is the job the org was shared for', () => {
    draw('general');
    expect(screen.getByTestId('org-share-open')).toBeTruthy();
  });

  it('offers no Share and no Invite when the hub says the caller may not manage members', () => {
    draw('general', { org: sharedOrg({ can_invite: false }) });
    expect(screen.queryByTestId('org-share-open')).toBeNull();
    cleanup();
    draw('members', { org: sharedOrg({ can_invite: false }) });
    expect(screen.queryByTestId('org-invite-open')).toBeNull();
  });

  it('offers Invite people on Members with can_invite', () => {
    draw('members');
    expect(screen.getByTestId('org-invite-open')).toBeTruthy();
  });

  it('still offers "New team", which is the admin\'s actual job', () => {
    draw('teams');
    expect(screen.getByTestId('org-create-team')).toBeTruthy();
  });

  it('offers no "New team" to someone who may not create under the org', () => {
    draw('teams', { org: sharedOrg({ can_add_child: false }) });
    expect(screen.queryByTestId('org-create-team')).toBeNull();
  });

  it('lets the admin set a team budget, which is the delegated job', () => {
    draw('teams', { teamId: UUID(4) });
    const teamCap = screen.getByTestId<HTMLInputElement>(`team-cap-${UUID(4)}`);
    expect(teamCap.disabled).toBe(false);
    fireEvent.change(teamCap, { target: { value: '55' } });
    fireEvent.blur(teamCap);
    expect(h.setCap).toHaveBeenCalledWith(expect.objectContaining({ usd: 55 }), expect.anything());
  });

  it('sets a team budget larger than the organization holds — the org still bounds the spend', () => {
    draw('teams', { teamId: UUID(4) });
    const teamCap = screen.getByTestId<HTMLInputElement>(`team-cap-${UUID(4)}`);
    fireEvent.change(teamCap, { target: { value: '101' } });
    fireEvent.blur(teamCap);
    expect(h.setCap).toHaveBeenCalledWith(expect.objectContaining({ usd: 101 }), expect.anything());
  });

  it('will not accept a team budget or default without can_configure on the team', () => {
    draw('teams', { teamId: UUID(4), teams: [team({ can_configure: false })] });
    expect(screen.getByTestId<HTMLInputElement>(`team-cap-${UUID(4)}`).disabled).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>(`team-default-cap-${UUID(4)}`).disabled).toBe(true);
  });

  it('offers no Add people without can_allocate on the team', () => {
    draw('teams', { teamId: UUID(4), teams: [team({ can_allocate: false })] });
    expect(screen.queryByTestId(`team-add-people-${UUID(4)}`)).toBeNull();
    expect(screen.queryByTestId(`team-share-project-${UUID(4)}`)).toBeNull();
  });

  it('offers no Remove beside a peer the caller cannot outrank', async () => {
    draw('teams', { teamId: UUID(4), members: [person({ can_remove: false })] });
    openMenu(`member-more-${EP(2)}`);
    expect(await screen.findByTestId(`member-advanced-${EP(2)}`)).toBeTruthy();
    expect(screen.queryByTestId(`member-remove-${EP(2)}`)).toBeNull();
  });

  it("will not accept a person's limit without can_configure on that row, and offers no reset", () => {
    h.pool.mockReturnValue({
      typeId: { type: 'llm_endpoint', id: UUID(5) },
      member_default_limits: { cost_usd_total: 20 },
    });
    draw('teams', { teamId: UUID(4), members: [person({ can_configure: false })] });
    expect(screen.getByTestId<HTMLInputElement>(`member-cap-${EP(2)}`).disabled).toBe(true);
    expect(screen.getByTestId(`member-limit-source-${EP(2)}`).textContent).toContain('custom');
    expect(screen.queryByTestId(`member-reset-${EP(2)}`)).toBeNull();
  });
});

/**
 * A brand new organization, before anyone has funded it. `can_set_credential` is the `credential`
 * question asked of the pool, so with no pool it is false for everyone — the owner is judged on
 * `can_set_up_budget` instead.
 */
describe('an organization with no budget yet', () => {
  const unfunded = (over: Record<string, unknown> = {}) =>
    sharedOrg({
      endpoint_id: null,
      is_root: false,
      provider: null,
      credential_hint: '',
      limit_usd: null,
      allocated_usd: null,
      can_set_credential: false,
      ...over,
    });

  it('offers its owner the setup form', () => {
    draw('billing', { org: unfunded({ can_set_up_budget: true, can_manage: true, can_configure: true }) });
    expect(screen.getByTestId('org-root-provider')).toBeTruthy();
    expect(screen.queryByTestId('org-root-owner-only')).toBeNull();
  });

  it('tells an admin that its owner sets one up, and offers no form', () => {
    draw('billing', { org: unfunded({ can_set_up_budget: false }) });
    expect(screen.getByTestId('org-root-owner-only')).toBeTruthy();
    expect(screen.queryByTestId('org-root-provider')).toBeNull();
  });
});
