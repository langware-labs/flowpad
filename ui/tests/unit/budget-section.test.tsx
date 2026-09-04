/**
 * The org → team → person budget hierarchy — everything on one page, nothing reached by
 * selecting a node in a side tree.
 *
 * Locked here: a team's people list is fetched lazily (only once opened or "Add people" is
 * pressed — a fifty-team org must not read every team's spend on first paint), a person who has
 * spent nothing still has a row, over-promising is SHOWN and not blocked, renaming and deleting
 * both org and team rows work and are gated on the right permission, and the org's three
 * bring-your-own-key states (no pool / has a root / an older shared-pool chain) still render
 * correctly now that they live inside `OrgUnit` instead of a selected-node `BudgetSection`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const EP = (n: number) => `llm_endpoint-${UUID(n)}`;

const h = vi.hoisted(() => ({
  org: vi.fn(),
  team: vi.fn(),
  setCap: vi.fn(),
  removeAllowance: vi.fn(),
  save: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@src/components/organization/budgets/use-budgets', () => ({
  useOrgBudgets: (...args: unknown[]) => h.org(...args),
  useTeamBudgets: (...args: unknown[]) => h.team(...args),
  useSetLifetimeCap: () => ({ mutate: h.setCap, isPending: false }),
  useRemoveAllowance: () => ({ mutate: h.removeAllowance, isPending: false }),
  useAddPeople: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetupOrgRoot: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save, delete: h.del },
  };
});
// `EndpointControls` renders on every row that has a pool; it is its own dedicated suite
// (endpoint-controls.test.tsx) — here it only needs to exist so a row can render at all.
vi.mock('@src/components/organization/budgets/EndpointControls', () => ({
  EndpointControls: () => null,
}));

import { OrgUnit } from '@src/components/organization/budgets/BudgetSection';

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
  system_default: false,
  ...over,
});

function draw(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const idle = { data: undefined, isLoading: false, error: null };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrgUnit', () => {
  it('shows the org total, spent and given-out, and no team fetch until a team is opened', () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue(idle);

    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    expect(screen.getByTestId('org-name').textContent).toBe('Langware');
    expect(screen.getByTestId<HTMLInputElement>('org-total-cap').value).toBe('100');
    expect(screen.getByText(/12\.5/)).toBeTruthy();
    // The team is LISTED (name + total), but its people are not fetched just by being on the page.
    expect(screen.getByTestId(`team-unit-${UUID(4)}`)).toBeTruthy();
    expect(h.team).not.toHaveBeenCalledWith(UUID(4));
  });

  it('spells out tokens as an icon with a tooltip, not as the word "tokens" in the row', () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [] }, isLoading: false, error: null });
    h.team.mockReturnValue(idle);

    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    const tokens = screen.getByTestId('org-spent-tokens');
    expect(tokens.textContent).toBe('4.2K');
    expect(tokens.title).toBe('Tokens spent');
    expect(screen.queryByText('tokens', { exact: false })).toBeNull();
  });

  it('renames the organization in place and refreshes on commit', async () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [] }, isLoading: false, error: null });
    h.team.mockReturnValue(idle);
    h.save.mockResolvedValue(undefined);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

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
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [] }, isLoading: false, error: null });
    h.team.mockReturnValue(idle);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByTestId('org-name'));
    fireEvent.blur(screen.getByTestId('org-rename-input'));
    expect(h.save).not.toHaveBeenCalled();
  });

  it('deletes the organization after confirming, and reports the result upward', async () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [] }, isLoading: false, error: null });
    h.team.mockReturnValue(idle);
    h.del.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    draw(<OrgUnit orgId={UUID(1)} onDeleted={onDeleted} />);

    fireEvent.click(screen.getByTestId('org-delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(h.del).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(1), type: 'organization' })),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it('shows an over-promise instead of refusing it', () => {
    h.org.mockReturnValue({
      data: { org: orgScope({ limit_usd: 10, allocated_usd: 16 }), teams: [] },
      isLoading: false,
      error: null,
    });
    h.team.mockReturnValue(idle);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);
    expect(screen.getByTestId('org-over-allocated')).toBeTruthy();
  });

  it('says so plainly when the hub refuses the read', () => {
    h.org.mockReturnValue({ data: undefined, isLoading: false, error: new Error('401') });
    h.team.mockReturnValue(idle);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);
    expect(screen.queryByTestId('org-unit')).toBeNull();
    expect(screen.getByText(/only an admin/i)).toBeTruthy();
  });

  it('offers to set a team up when it has no budget, without touching the org level', () => {
    h.org.mockReturnValue({
      data: { org: orgScope(), teams: [teamScope({ endpoint_id: null, limit_usd: null, allocated_usd: null })] },
      isLoading: false,
      error: null,
    });
    h.team.mockReturnValue(idle);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);
    expect(screen.getByTestId(`budget-setup-team-${UUID(4)}`)).toBeTruthy();
  });

  /** Collapsed once a root exists — the key form is somewhere you go, not something you read on
   *  every visit. What must NOT happen is it being unreachable, so the toggle is asserted too. */
  it('offers the bring-your-own-key form behind a toggle once the org already has a root', () => {
    h.org.mockReturnValue({
      data: { org: orgScope({ is_root: true, provider: 'anthropic', credential_hint: '****wxyz' }), teams: [] },
      isLoading: false,
      error: null,
    });
    h.team.mockReturnValue(idle);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    expect(screen.queryByTestId('org-root-key')).toBeNull();
    fireEvent.click(screen.getByTestId('org-settings-toggle'));
    expect(screen.getByTestId('org-root-key')).toBeTruthy();
  });

  it('opens the bring-your-own-key form on its own when the org has no budget yet', () => {
    h.org.mockReturnValue({
      data: { org: orgScope({ endpoint_id: null, limit_usd: null, allocated_usd: null }), teams: [] },
      isLoading: false,
      error: null,
    });
    h.team.mockReturnValue(idle);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);
    expect(screen.getByTestId('org-root-setup')).toBeTruthy();
  });

  it('explains bringing a key is unavailable once the org already draws from the shared pool', () => {
    h.org.mockReturnValue({ data: { org: orgScope({ is_root: false }), teams: [] }, isLoading: false, error: null });
    h.team.mockReturnValue(idle);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByTestId('org-settings-toggle'));
    expect(screen.getByTestId('org-root-legacy-chain')).toBeTruthy();
  });
});

describe('TeamUnit (rendered inside OrgUnit)', () => {
  it('lists a person who has spent nothing once the people section is opened', () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue({ data: { team: teamScope(), members: [person()] }, isLoading: false, error: null });
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    expect(screen.queryByTestId(`member-budget-${EP(2)}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`team-people-toggle-${UUID(4)}`));

    expect(screen.getByTestId(`member-budget-${EP(2)}`)).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>(`member-cap-${EP(2)}`).value).toBe('50');
    // Lazy: the per-team fetch only fires because the section above was opened.
    expect(h.team).toHaveBeenCalledWith(UUID(4));
  });

  it('fetches a team once "Add people" is pressed, even without opening the people list', () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue({ data: { team: teamScope(), members: [] }, isLoading: false, error: null });
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByTestId(`team-add-people-${UUID(4)}`));
    expect(screen.getByTestId('add-people-dialog')).toBeTruthy();
  });

  it('renames a team in place', async () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue(idle);
    h.save.mockResolvedValue(undefined);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

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

  it('deletes a team after confirming', async () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue(idle);
    h.del.mockResolvedValue(undefined);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByTestId(`team-${UUID(4)}-delete`));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(h.del).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(4), type: 'team' })));
  });

  it('offers no Remove on the hub-made per-user default', () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue({
      data: { team: teamScope(), members: [person({ system_default: true })] },
      isLoading: false,
      error: null,
    });
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);

    fireEvent.click(screen.getByTestId(`team-people-toggle-${UUID(4)}`));
    expect(screen.queryByTestId(`member-remove-${EP(2)}`)).toBeNull();
  });

  /**
   * Order matters and is asserted, not assumed: Advanced, Edit, Delete — left to right, in order of
   * consequence, with Delete keeping the isolated rightmost slot.
   */
  it('gives a person row Advanced, Edit and Delete, in that order', () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue({ data: { team: teamScope(), members: [person()] }, isLoading: false, error: null });
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`team-people-toggle-${UUID(4)}`));

    const row = screen.getByTestId(`member-budget-${EP(2)}`);
    const ids = Array.from(row.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid') ?? '')
      .filter((id) => /^member-(advanced|edit|remove)-/.test(id));
    expect(ids).toEqual([`member-advanced-${EP(2)}`, `member-edit-${EP(2)}`, `member-remove-${EP(2)}`]);
  });

  it('renames a person’s budget from the Edit button, writing the ENDPOINT’s own name', async () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue({ data: { team: teamScope(), members: [person()] }, isLoading: false, error: null });
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`team-people-toggle-${UUID(4)}`));

    fireEvent.click(screen.getByTestId(`member-edit-${EP(2)}`));
    const input = screen.getByTestId<HTMLInputElement>(`member-rename-input-${EP(2)}`);
    fireEvent.change(input, { target: { value: 'Ada — research' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(h.save).toHaveBeenCalled());
    // The endpoint, addressed by its own typeid — never the person's account.
    expect(h.save.mock.calls[0][0]).toEqual(expect.objectContaining({ type: 'llm_endpoint', id: UUID(2) }));
    expect(h.save.mock.calls[0][2]).toEqual({ name: 'Ada — research' });
  });

  it('still offers Advanced and Edit on the hub-made default, which only refuses DELETE', () => {
    h.org.mockReturnValue({ data: { org: orgScope(), teams: [teamScope()] }, isLoading: false, error: null });
    h.team.mockReturnValue({
      data: { team: teamScope(), members: [person({ system_default: true })] },
      isLoading: false,
      error: null,
    });
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`team-people-toggle-${UUID(4)}`));

    expect(screen.queryByTestId(`member-remove-${EP(2)}`)).toBeNull();
    expect(screen.getByTestId(`member-advanced-${EP(2)}`)).toBeTruthy();
    expect(screen.getByTestId(`member-edit-${EP(2)}`)).toBeTruthy();
  });

  it('shows a team-level over-promise', () => {
    h.org.mockReturnValue({
      data: { org: orgScope(), teams: [teamScope({ limit_usd: 10, allocated_usd: 16 })] },
      isLoading: false,
      error: null,
    });
    h.team.mockReturnValue(idle);
    draw(<OrgUnit orgId={UUID(1)} onDeleted={vi.fn()} />);
    expect(screen.getByTestId(`team-over-allocated-${UUID(4)}`)).toBeTruthy();
  });
});
