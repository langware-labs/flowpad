/**
 * People & teams for ONE organization (`OrgView`): tabs Teams | Members | Billing & keys | General,
 * and a team's own page (`TeamDetail`).
 *
 * Locked here: a team's people are fetched lazily (only on its own page — a fifty-team org must
 * not read every team's spend on the Teams tab), a person who has spent nothing still has a row,
 * an over-promise that ALREADY EXISTS is shown and not blocked, renaming and deleting both org
 * (General) and team (TeamDetail) work and are gated on `can_manage`, and the org's three
 * bring-your-own-key states (no pool / has a root / an older shared-pool chain) render on Billing.
 *
 * The default fixtures describe an OWNER — every `can_*` true. What a SHARED organization's admin
 * sees instead is the subject of `shared-org-admin-page.test.tsx`, which flips the same flags off.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { mergeOrgMembers } from '@src/components/organization/tabs/MembersTab';
import type { OrgTab } from '@src/components/organization/tabs/org-route';

const orgScope = (over: Record<string, unknown> = {}) => ({
  id: UUID(1),
  name: 'Langware',
  endpoint_id: EP(1),
  limit_usd: 100,
  spent_usd: 12.5,
  spent_tokens: 4200,
  allocated_usd: 40,
  is_root: false,
  provider: null,
  credential_hint: '',
  can_configure: true,
  can_allocate: true,
  can_manage: true,
  can_add_child: true,
  can_set_credential: true,
  can_set_up_budget: true,
  can_invite: true,
  ...over,
});

const teamScope = (over: Record<string, unknown> = {}) => ({
  id: UUID(4),
  name: 'Platform',
  endpoint_id: EP(5),
  limit_usd: 40,
  spent_usd: 5,
  spent_tokens: 900,
  allocated_usd: null,
  my_role: null,
  member_count: null,
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

const idle = { data: undefined, isLoading: false, error: null };

function draw(
  props: { tab?: OrgTab; teamId?: string | null; name?: string; onDeleted?: () => void; onOpenTeam?: () => void } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <OrgView
          orgId={UUID(1)}
          name={props.name}
          tab={props.tab ?? 'teams'}
          teamId={props.teamId ?? null}
          onTab={vi.fn()}
          onOpenTeam={props.onOpenTeam ?? vi.fn()}
          onCloseTeam={vi.fn()}
          onDeleted={props.onDeleted ?? vi.fn()}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function orgReturns(org = orgScope(), teams: unknown[] = [], people: unknown[] = []) {
  h.org.mockReturnValue({ data: { org, teams, people }, isLoading: false, error: null, refetch: vi.fn() });
}

/** Radix menus open on pointerdown, not click. */
function openMenu(testId: string) {
  const trigger = screen.getByTestId(testId);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.keyDown(trigger, { key: 'Enter' });
}

beforeEach(() => {
  h.team.mockReturnValue(idle);
  h.teamBudgets.mockResolvedValue({ team: teamScope(), members: [] });
  h.pool.mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrgView', () => {
  it('says so, rather than white-screening or spinning, when the payload arrives without an org', () => {
    h.org.mockReturnValue({ data: { teams: [] }, isLoading: false, error: null, refetch: vi.fn() });
    expect(() => draw()).not.toThrow();
    expect(screen.queryByTestId('org-unit')).toBeNull();
    expect(screen.getByTestId('org-unit-unreadable')).toBeTruthy();
  });

  it('a null payload is a dead end too, not a wait', () => {
    h.org.mockReturnValue({ data: null, isLoading: false, error: null, refetch: vi.fn() });
    draw();
    expect(screen.getByTestId('org-unit-unreadable')).toBeTruthy();
  });

  it('still waits while the read is actually in flight', () => {
    h.org.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: vi.fn() });
    draw();
    expect(screen.queryByTestId('org-unit-unreadable')).toBeNull();
  });

  it('a non-permission error is "could not read", not the member card', () => {
    h.org.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom'), refetch: vi.fn() });
    draw();
    expect(screen.getByTestId('org-unit-unreadable')).toBeTruthy();
  });

  it('renders the four tabs', () => {
    orgReturns();
    draw();
    for (const id of ['teams', 'members', 'billing', 'general']) {
      expect(screen.getByTestId(`org-tab-${id}`)).toBeTruthy();
    }
  });

  it('lists the team on the Teams tab without fetching its people', () => {
    orgReturns(orgScope(), [teamScope()]);
    draw();
    expect(screen.getByTestId(`team-unit-${UUID(4)}`)).toBeTruthy();
    expect(screen.getByTestId('org-spend-strip').textContent).toContain('12.5');
    expect(h.team).not.toHaveBeenCalledWith(UUID(4));
  });

  it('opens a team from its row', () => {
    orgReturns(orgScope(), [teamScope()]);
    const onOpenTeam = vi.fn();
    draw({ onOpenTeam });
    fireEvent.click(screen.getByTestId(`team-unit-${UUID(4)}`));
    expect(onOpenTeam).toHaveBeenCalledWith(UUID(4));
  });

  it('shows the caller’s role on a team, or a dash, and its head count', () => {
    orgReturns(orgScope(), [
      teamScope({ my_role: 'admin', member_count: 3 }),
      teamScope({ id: UUID(6), name: 'Growth', my_role: null, member_count: 1 }),
    ]);
    draw();
    expect(screen.getByTestId(`team-${UUID(4)}-role`).textContent).toBe('admin');
    expect(screen.getByTestId(`team-${UUID(6)}-role`).textContent).toBe('—');
    expect(screen.getByTestId(`team-${UUID(4)}-members`).textContent).toBe('3 members');
    expect(screen.getByTestId(`team-${UUID(6)}-members`).textContent).toBe('1 member');
  });

  it('"Only my teams" keeps the teams the caller holds a role on', () => {
    orgReturns(orgScope(), [
      teamScope({ my_role: 'member' }),
      teamScope({ id: UUID(6), name: 'Growth', my_role: null }),
    ]);
    draw();
    expect(screen.getByTestId(`team-unit-${UUID(6)}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('org-teams-mine'));
    expect(screen.getByTestId(`team-unit-${UUID(4)}`)).toBeTruthy();
    expect(screen.queryByTestId(`team-unit-${UUID(6)}`)).toBeNull();
  });

  it('shows the org total, spent and given-out on Billing', () => {
    orgReturns();
    draw({ tab: 'billing' });
    expect(screen.getByTestId<HTMLInputElement>('org-total-cap').value).toBe('100');
    expect(screen.getByTestId('org-spent').textContent).toContain('12.5');
    expect(screen.getByTestId('org-allocated').textContent).toContain('40');
  });

  it('shows an org over-promise instead of refusing it', () => {
    orgReturns(orgScope({ limit_usd: 10, allocated_usd: 16 }));
    draw({ tab: 'billing' });
    expect(screen.getByTestId('org-over-allocated')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>('org-total-cap').disabled).toBe(false);
  });

  it('renames the organization in place on General', async () => {
    orgReturns();
    h.save.mockResolvedValue(undefined);
    draw({ tab: 'general' });

    fireEvent.click(screen.getByTestId('org-name'));
    const input = screen.getByTestId<HTMLInputElement>('org-rename-input');
    fireEvent.change(input, { target: { value: 'Acme Inc' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(1), type: 'organization' }), [], {
        name: 'Acme Inc',
      }),
    );
  });

  it('does not rename on a no-op commit', () => {
    orgReturns();
    draw({ tab: 'general' });
    fireEvent.click(screen.getByTestId('org-name'));
    fireEvent.blur(screen.getByTestId('org-rename-input'));
    expect(h.save).not.toHaveBeenCalled();
  });

  it('deletes the organization only after its name is typed, and reports upward', async () => {
    orgReturns();
    h.getByTypeId.mockResolvedValue({ id: UUID(1), type: 'organization' });
    h.del.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    draw({ tab: 'general', onDeleted });

    fireEvent.click(screen.getByTestId('org-delete'));
    const confirm = screen.getByTestId<HTMLButtonElement>('org-delete-confirm');
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('org-delete-confirm-name'), { target: { value: 'Langware' } });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(h.del).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(1), type: 'organization' })),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it('offers no rename and no delete of the org without can_manage', () => {
    orgReturns(orgScope({ can_manage: false }));
    draw({ tab: 'general' });
    expect(screen.getByTestId('org-name').tagName).toBe('SPAN');
    expect(screen.queryByTestId('org-delete')).toBeNull();
  });

  it('offers the org id as a copy icon, without printing it', async () => {
    orgReturns();
    draw({ tab: 'general' });
    expect(screen.queryByText(UUID(1))).toBeNull();
    fireEvent.click(screen.getByTestId('org-copy-id'));
    await waitFor(() => expect(h.copyToClipboard).toHaveBeenCalledWith(UUID(1)));
  });

  it('shows the key field once the org already has a root', () => {
    orgReturns(orgScope({ is_root: true, provider: 'anthropic', credential_hint: '****wxyz' }));
    draw({ tab: 'billing' });
    expect(screen.getByTestId('org-root-key')).toBeTruthy();
  });

  it('opens the bring-your-own-key form when the org has no budget yet', () => {
    orgReturns(orgScope({ endpoint_id: null, limit_usd: null, allocated_usd: null }));
    draw({ tab: 'billing' });
    expect(screen.getByTestId('org-root-setup')).toBeTruthy();
    expect(screen.queryByTestId('org-budget')).toBeNull();
  });

  it('explains bringing a key is unavailable once the org draws from the shared pool', () => {
    orgReturns(orgScope({ is_root: false }));
    draw({ tab: 'billing' });
    expect(screen.getByTestId('org-root-legacy-chain')).toBeTruthy();
  });

  it('shows a plain member the org name and their own teams when budgets are refused', () => {
    h.org.mockReturnValue({ data: undefined, isLoading: false, error: { response: { status: 403 } } });
    h.entities.mockReturnValue({ data: [{ id: UUID(4), name: 'Platform' }], isLoading: false } as never);
    draw({ name: 'Acme' });

    expect(screen.getByTestId('org-unit').getAttribute('data-readonly')).toBe('true');
    expect(screen.getByTestId('org-name').textContent).toBe('Acme');
    expect(screen.getByTestId(`org-member-team-${UUID(4)}`).textContent).toContain('Platform');
    expect(screen.queryByTestId('org-tabs')).toBeNull();
    expect(screen.queryByTestId('org-total-cap')).toBeNull();
  });
});

describe('TeamDetail (opened through OrgView)', () => {
  it('fetches the team’s people on its own page and lists someone who has spent nothing', () => {
    orgReturns(orgScope(), [teamScope()]);
    h.team.mockReturnValue({ data: { team: teamScope(), members: [person()] }, isLoading: false, error: null });
    draw({ teamId: UUID(4) });

    expect(h.team).toHaveBeenCalledWith(UUID(4));
    expect(screen.getByTestId(`member-budget-${EP(2)}`)).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByTestId(`member-spent-${EP(2)}`).textContent).toContain('0');
    expect(screen.getByTestId<HTMLInputElement>(`member-cap-${EP(2)}`).value).toBe('50');
  });

  it('falls back to the Teams list when the team id is not in the org', () => {
    orgReturns(orgScope(), [teamScope()]);
    draw({ teamId: UUID(9) });
    expect(screen.getByTestId('org-teams-tab')).toBeTruthy();
  });

  it('shows a team-level over-promise', () => {
    orgReturns(orgScope(), [teamScope({ limit_usd: 10, allocated_usd: 16 })]);
    draw({ teamId: UUID(4) });
    expect(screen.getByTestId(`team-over-allocated-${UUID(4)}`)).toBeTruthy();
  });

  it('sets a team cap', () => {
    orgReturns(orgScope(), [teamScope()]);
    draw({ teamId: UUID(4) });
    const cap = screen.getByTestId<HTMLInputElement>(`team-cap-${UUID(4)}`);
    fireEvent.change(cap, { target: { value: '55' } });
    fireEvent.blur(cap);
    expect(h.setCap).toHaveBeenCalledWith({ endpointId: EP(5), usd: 55 }, expect.anything());
  });

  it('renames a team in place', async () => {
    orgReturns(orgScope(), [teamScope()]);
    h.save.mockResolvedValue(undefined);
    draw({ teamId: UUID(4) });

    fireEvent.click(screen.getByTestId(`team-${UUID(4)}-name`));
    const input = screen.getByTestId<HTMLInputElement>(`team-${UUID(4)}-rename-input`);
    fireEvent.change(input, { target: { value: 'Growth' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(4), type: 'team' }), [], {
        name: 'Growth',
      }),
    );
  });

  it('deletes a team after confirming, loading it as an entity first', async () => {
    // `dataManager.delete` is cache-first; a team row comes from the budgets aggregate, so without
    // the load the DELETE never leaves the browser.
    orgReturns(orgScope(), [teamScope()]);
    h.getByTypeId.mockResolvedValue({ id: UUID(4), type: 'team' });
    h.del.mockResolvedValue(undefined);
    draw({ teamId: UUID(4) });

    fireEvent.click(screen.getByTestId(`team-${UUID(4)}-delete`));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(h.getByTypeId).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(4), type: 'team' })),
    );
    await waitFor(() => expect(h.del).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(4), type: 'team' })));
  });

  it('offers no rename and no delete of a team without can_manage', () => {
    orgReturns(orgScope(), [teamScope({ can_manage: false })]);
    draw({ teamId: UUID(4) });
    expect(screen.getByTestId(`team-${UUID(4)}-name`).tagName).toBe('SPAN');
    expect(screen.queryByTestId(`team-${UUID(4)}-delete`)).toBeNull();
    openMenu(`team-more-${UUID(4)}`);
    expect(screen.queryByTestId(`team-delete-menu-${UUID(4)}`)).toBeNull();
  });

  it('offers to set a team up when it has no budget', () => {
    orgReturns(orgScope(), [teamScope({ endpoint_id: null, limit_usd: null, allocated_usd: null })]);
    draw({ teamId: UUID(4) });
    expect(screen.getByTestId(`budget-setup-team-${UUID(4)}`)).toBeTruthy();
  });

  it('marks a limit equal to the team default "team default", any other "custom", and resets to the default', () => {
    h.pool.mockReturnValue({
      typeId: { type: 'llm_endpoint', id: UUID(5) },
      member_default_limits: { cost_usd_total: 20 },
    });
    orgReturns(orgScope(), [teamScope()]);
    h.team.mockReturnValue({
      data: {
        team: teamScope(),
        members: [person({ limit_usd: 20 }), person({ endpoint_id: EP(6), name: 'Alan', limit_usd: 75 })],
      },
      isLoading: false,
      error: null,
    });
    draw({ teamId: UUID(4) });

    expect(screen.getByTestId(`member-limit-source-${EP(2)}`).textContent).toBe('team default');
    expect(screen.queryByTestId(`member-reset-${EP(2)}`)).toBeNull();
    expect(screen.getByTestId(`member-limit-source-${EP(6)}`).textContent).toContain('custom');

    fireEvent.click(screen.getByTestId(`member-reset-${EP(6)}`));
    expect(h.setCap).toHaveBeenCalledWith({ endpointId: EP(6), usd: 20 }, expect.anything());
  });

  it('says neither "default" nor "custom" before the team pool has loaded', () => {
    orgReturns(orgScope(), [teamScope()]);
    h.team.mockReturnValue({ data: { team: teamScope(), members: [person()] }, isLoading: false, error: null });
    draw({ teamId: UUID(4) });
    expect(screen.queryByTestId(`member-limit-source-${EP(2)}`)).toBeNull();
  });

  it('removes a PERSON from the team, never their allowance; deletes a holderless allowance', async () => {
    orgReturns(orgScope(), [teamScope()]);
    h.team.mockReturnValue({
      data: { team: teamScope(), members: [person(), person({ endpoint_id: EP(7), name: 'Pending', user_id: null })] },
      isLoading: false,
      error: null,
    });
    draw({ teamId: UUID(4) });

    expect(screen.getByTestId(`member-pending-${EP(7)}`)).toBeTruthy();
    openMenu(`member-more-${EP(2)}`);
    fireEvent.click(await screen.findByTestId(`member-remove-${EP(2)}`));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(h.removeMember).toHaveBeenCalledWith({ teamId: UUID(4), userId: UUID(3) }, expect.anything()),
    );
    expect(h.removeAllowance).not.toHaveBeenCalled();
  });

  it('offers Remove only on a row the hub says this caller may remove', async () => {
    orgReturns(orgScope(), [teamScope()]);
    h.team.mockReturnValue({
      data: { team: teamScope(), members: [person({ can_remove: false })] },
      isLoading: false,
      error: null,
    });
    draw({ teamId: UUID(4) });
    openMenu(`member-more-${EP(2)}`);
    expect(await screen.findByTestId(`member-advanced-${EP(2)}`)).toBeTruthy();
    expect(screen.queryByTestId(`member-remove-${EP(2)}`)).toBeNull();
  });

  it('emails one person about the TEAM from their row menu', async () => {
    orgReturns(orgScope(), [teamScope()]);
    h.team.mockReturnValue({ data: { team: teamScope(), members: [person()] }, isLoading: false, error: null });
    h.invite.mockResolvedValue({ invited: ['ada@example.com'], already: [], failed: [] });
    draw({ teamId: UUID(4) });
    openMenu(`member-more-${EP(2)}`);
    fireEvent.click(await screen.findByTestId(`member-invite-${EP(2)}`));
    await waitFor(() => expect(h.invite).toHaveBeenCalledWith(UUID(4), ['ada@example.com']));
  });

  it('offers no invite and no Add people to someone who may not bring people in', async () => {
    orgReturns(orgScope(), [teamScope({ can_allocate: false })]);
    h.team.mockReturnValue({ data: { team: teamScope(), members: [person()] }, isLoading: false, error: null });
    draw({ teamId: UUID(4) });
    expect(screen.queryByTestId(`team-add-people-${UUID(4)}`)).toBeNull();
    openMenu(`member-more-${EP(2)}`);
    expect(await screen.findByTestId(`member-advanced-${EP(2)}`)).toBeTruthy();
    expect(screen.queryByTestId(`member-invite-${EP(2)}`)).toBeNull();
  });

  it('offers Add people once the roster is loaded', () => {
    orgReturns(orgScope(), [teamScope()]);
    h.team.mockReturnValue({ data: { team: teamScope(), members: [] }, isLoading: false, error: null });
    draw({ teamId: UUID(4) });
    fireEvent.click(screen.getByTestId(`team-add-people-${UUID(4)}`));
    expect(screen.getByTestId('add-people-dialog')).toBeTruthy();
  });
});

describe('Members tab', () => {
  it('lists a teamless person from the org read, and the "No team" filter keeps them', async () => {
    orgReturns(
      orgScope(),
      [teamScope()],
      [{ user_id: UUID(9), name: 'Bob Example', email: 'bob@x.test', role: 'admin' }],
    );
    h.teamBudgets.mockResolvedValue({ team: teamScope(), members: [person()] });
    draw({ tab: 'members' });

    expect((await screen.findByTestId(`org-person-${UUID(9)}`)).textContent).toContain('Bob Example');
    expect(await screen.findByTestId(`org-person-${UUID(3)}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('org-members-filter-no-team'));
    expect(screen.getByTestId(`org-person-${UUID(9)}`)).toBeTruthy();
    expect(screen.queryByTestId(`org-person-${UUID(3)}`)).toBeNull();
  });

  it('renders against a hub that does not send `people`', () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [] }, isLoading: false, error: null });
    draw({ tab: 'members' });
    expect(screen.getByTestId('org-members-tab')).toBeTruthy();
  });
});

describe('mergeOrgMembers', () => {
  const m = (over: Record<string, unknown> = {}) => ({ ...person(), ...over }) as never;
  const teams = [{ name: 'Platform' }, { name: 'Growth' }] as never;

  it('merges one person across rosters by user_id, summing spend and listing each team', () => {
    const rows = mergeOrgMembers(
      { teams, people: [] },
      [{ members: [m({ spent_usd: 2 })] }, { members: [m({ endpoint_id: EP(8), spent_usd: 3 })] }] as never,
      new Map([[UUID(3), 'owner']]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: UUID(3),
      teams: ['Platform', 'Growth'],
      spent: 5,
      role: 'owner',
      pending: false,
    });
  });

  it('marks a holderless allowance pending, keyed by email', () => {
    const rows = mergeOrgMembers(
      { teams, people: [] },
      [{ members: [m({ user_id: null, email: 'new@x.test' })] }, undefined] as never,
      new Map(),
    );
    expect(rows[0]).toMatchObject({ key: 'new@x.test', user_id: null, pending: true, role: null });
  });

  it('adds teamless people from `people`, without duplicating someone already on a team', () => {
    const rows = mergeOrgMembers(
      {
        teams,
        people: [
          { user_id: UUID(3), name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin' },
          { user_id: UUID(9), name: 'bob', email: null, role: 'member' },
        ],
      } as never,
      [{ members: [m()] }, undefined] as never,
      new Map(),
    );
    expect(rows.map((r) => r.key)).toEqual([UUID(3), UUID(9)]);
    expect(rows[1]).toMatchObject({ teams: [], spent: 0, role: 'member', pending: false });
  });
});
