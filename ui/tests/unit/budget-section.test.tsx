/**
 * The budgets section on People & teams — what an owner actually sees.
 *
 * The regression this screen exists to prevent: a person handed an allowance who has not spent a
 * cent must have a row. The hub's older `usage?by=child` breakdown is built from the ledger, so it
 * omits exactly that person, which is why there is a `budgets` action at all.
 *
 * Also locked: over-promising is SHOWN and not blocked (the hub catches the excess at spend time,
 * along the whole chain), and the hub-made per-user default offers no Remove — deleting one only
 * makes it reappear on that person's next read.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
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
}));

import { BudgetSection } from '@src/components/organization/budgets/BudgetSection';

const scope = (over: Record<string, unknown> = {}) => ({
  id: UUID(1),
  name: 'Platform',
  endpoint_id: EP(1),
  limit_usd: 100,
  spent_usd: 12.5,
  allocated_usd: 40,
  ...over,
});

const person = (over: Record<string, unknown> = {}) => ({
  endpoint_id: EP(2),
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  user_id: UUID(3),
  limit_usd: 50,
  spent_usd: 0,
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

describe('BudgetSection — a team', () => {
  it('lists a person who has spent nothing, with their address and an editable amount', () => {
    h.team.mockReturnValue({ data: { team: scope(), members: [person()] }, isLoading: false, error: null });
    h.org.mockReturnValue(idle);

    draw(<BudgetSection nodeType="team" nodeId={UUID(1)} nodeLabel="Platform" />);

    expect(screen.getByTestId(`member-budget-${EP(2)}`)).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>(`member-cap-${EP(2)}`).value).toBe('50');
  });

  it('only asks the hub for the team that is open', () => {
    h.team.mockReturnValue({ data: { team: scope(), members: [] }, isLoading: false, error: null });
    h.org.mockReturnValue(idle);

    draw(<BudgetSection nodeType="team" nodeId={UUID(1)} nodeLabel="Platform" />);

    expect(h.team).toHaveBeenCalledWith(UUID(1));
    // The per-person fan-out is the expensive call; the org read must not also fire from here.
    expect(h.org).not.toHaveBeenCalled();
  });

  it('shows an over-promise instead of refusing it', () => {
    h.team.mockReturnValue({
      data: { team: scope({ limit_usd: 10, allocated_usd: 16 }), members: [] },
      isLoading: false,
      error: null,
    });
    h.org.mockReturnValue(idle);

    draw(<BudgetSection nodeType="team" nodeId={UUID(1)} nodeLabel="Platform" />);

    expect(screen.getByTestId('team-over-allocated')).toBeTruthy();
  });

  it('offers no Remove on the hub-made per-user default', () => {
    h.team.mockReturnValue({
      data: { team: scope(), members: [person({ system_default: true })] },
      isLoading: false,
      error: null,
    });
    h.org.mockReturnValue(idle);

    draw(<BudgetSection nodeType="team" nodeId={UUID(1)} nodeLabel="Platform" />);

    expect(screen.queryByTestId(`member-remove-${EP(2)}`)).toBeNull();
  });

  it('offers to set one up when the team has no budget, and hides the roster', () => {
    h.team.mockReturnValue({
      data: { team: scope({ endpoint_id: null, limit_usd: null, allocated_usd: null }), members: [] },
      isLoading: false,
      error: null,
    });
    h.org.mockReturnValue(idle);

    draw(<BudgetSection nodeType="team" nodeId={UUID(1)} nodeLabel="Platform" />);

    expect(screen.getByTestId(`budget-setup-team-${UUID(1)}`)).toBeTruthy();
    expect(screen.queryByTestId('budget-add-people')).toBeNull();
  });

  it('says so plainly when the hub refuses the read', () => {
    h.team.mockReturnValue({ data: undefined, isLoading: false, error: new Error('401') });
    h.org.mockReturnValue(idle);

    draw(<BudgetSection nodeType="team" nodeId={UUID(1)} nodeLabel="Platform" />);

    expect(screen.queryByTestId('team-budget-section')).toBeNull();
    expect(screen.getByText(/only an admin/i)).toBeTruthy();
  });
});

describe('BudgetSection — an organization', () => {
  it('lists its teams with their own amounts, and does not fetch any team roster', () => {
    h.org.mockReturnValue({
      data: {
        org: scope({ name: 'Langware', allocated_usd: 60 }),
        teams: [scope({ id: UUID(4), name: 'Growth', endpoint_id: EP(5), limit_usd: 60, allocated_usd: null })],
      },
      isLoading: false,
      error: null,
    });
    h.team.mockReturnValue(idle);

    draw(<BudgetSection nodeType="organization" nodeId={UUID(1)} nodeLabel="Langware" />);

    expect(screen.getByTestId(`org-budget-team-${UUID(4)}`)).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>(`team-cap-${UUID(4)}`).value).toBe('60');
    // The org branch never mounts the team panel, so the expensive per-person read is not merely
    // disabled — it is never requested.
    expect(h.team).not.toHaveBeenCalled();
  });

  it('offers to set a team up from the org view when that team has no budget', () => {
    h.org.mockReturnValue({
      data: {
        org: scope(),
        teams: [scope({ id: UUID(4), name: 'Growth', endpoint_id: null, limit_usd: null, allocated_usd: null })],
      },
      isLoading: false,
      error: null,
    });
    h.team.mockReturnValue(idle);

    draw(<BudgetSection nodeType="organization" nodeId={UUID(1)} nodeLabel="Langware" />);

    expect(screen.getByTestId(`budget-setup-team-${UUID(4)}`)).toBeTruthy();
  });
});
