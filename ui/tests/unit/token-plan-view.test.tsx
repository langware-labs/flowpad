/**
 * `TokenPlanView` — scope switching is a pointer navigation; empty states and
 * admin gating come off the hub's `can_configure`; chips, the expert link and
 * member rows drill into the endpoint page with the right pointer.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMUsageCounters, TokenPlan, TokenPlanScope } from '@sdk';

import { ZERO_COUNTERS } from '@src/components/llm-endpoints/usage-math';

const h = vi.hoisted(() => ({
  openPage: vi.fn(),
  me: vi.fn<() => Promise<unknown>>(),
  setupTeam: vi.fn(() => Promise.resolve({ endpoint_id: 'new' })),
  setupOrg: vi.fn(() => Promise.resolve({ endpoint_id: 'new' })),
  getUsage: vi.fn<(id: string, q: { by?: string; granularity: string }) => Promise<unknown>>(),
  endpoints: [] as unknown[],
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    tokenPlanService: { me: h.me, setupTeam: h.setupTeam, setupOrg: h.setupOrg },
    llmEndpointsService: { ...(actual.llmEndpointsService as object), getUsage: h.getUsage },
  };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage: h.openPage }, currentDock: { page: 'hub' } }),
}));
vi.mock('@src/components/llm-endpoints/LlmEndpointDialog', () => ({
  LlmEndpointDialog: () => <div data-testid="endpoint-dialog" />,
}));
vi.mock('@src/components/llm-endpoints/use-llm-endpoints', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmEndpoints: () => ({ endpoints: h.endpoints, refetch: vi.fn() }),
}));
vi.mock('@src/components/token-plan/SetBudgetSheet', () => ({
  SetBudgetSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="sheet-open" /> : null),
}));

import { LLMEndpoint, PageId, ViewType } from '@sdk';

import { TokenPlanView } from '@src/components/token-plan/TokenPlanView';
import { TooltipProvider } from '@src/components/ui/tooltip';

const ME_EP = '11111111-0000-4000-8000-000000000000';
const TEAM_EP = '22222222-0000-4000-8000-000000000000';
const ORG_EP = '33333333-0000-4000-8000-000000000000';
const OTHER_EP = '44444444-0000-4000-8000-000000000000';
const TEAM_ID = 'aaaaaaaa-0000-4000-8000-000000000000';
const c = (over: Partial<LLMUsageCounters>): LLMUsageCounters => ({ ...ZERO_COUNTERS, ...over });
const totals = { today: c({}), week: c({}), month: c({}), all: c({}) };
const now = Math.floor(Date.now() / 1000);

function scope(over: Partial<TokenPlanScope>): TokenPlanScope {
  return {
    kind: 'me',
    id: 'u',
    name: 'Alice',
    endpoint_id: ME_EP,
    can_configure: false,
    path: [],
    headline: null,
    remaining: [],
    totals,
    series: [],
    ...over,
  };
}

const meScope = scope({
  path: [
    { endpoint_id: ME_EP, name: 'default-alice', kind: 'me' },
    { endpoint_id: TEAM_EP, name: 'Team A', kind: 'team' },
    { endpoint_id: ORG_EP, name: 'Langware', kind: 'org' },
  ],
  headline: { key: 'cost_usd_per_day', used: 3.2, limit: 5, remaining: 1.8, resets_at: now + 4 * 3600, window: 'day' },
  remaining: [
    { key: 'cost_usd_per_day', used: 3.2, limit: 5, remaining: 1.8, resets_at: now + 4 * 3600, window: 'day' },
  ],
});
const teamScope = scope({
  kind: 'team',
  id: TEAM_ID,
  name: 'Team A',
  endpoint_id: TEAM_EP,
  can_configure: true,
  path: [
    { endpoint_id: TEAM_EP, name: 'Team A', kind: 'team' },
    { endpoint_id: ORG_EP, name: 'Langware', kind: 'org' },
  ],
  headline: {
    key: 'cost_usd_per_month',
    used: 42,
    limit: 100,
    remaining: 58,
    resets_at: now + 86400 * 5,
    window: 'month',
  },
  remaining: [
    { key: 'cost_usd_per_month', used: 42, limit: 100, remaining: 58, resets_at: now + 86400 * 5, window: 'month' },
  ],
});
const orgScope = scope({ kind: 'org', id: 'o', name: 'Langware', endpoint_id: null, can_configure: false, path: [] });

function ep(
  id: string,
  name: string,
  parents: string[],
  scopeKind: string,
  o: { allocate?: boolean; mine?: boolean; left?: [number, number] } = {},
): LLMEndpoint {
  const e = new LLMEndpoint({ id, name } as never);
  e.expand = {
    allowed_actions: (o.allocate ? ['read', 'allocate'] : ['read']) as never,
    expansions: ['permissions'] as never,
    mine: o.mine ?? false,
    source_ids: parents.map((p) => `llm_endpoint-${p}`),
    scope_kind: scopeKind,
    remaining: o.left
      ? [
          {
            key: 'cost_usd_per_month',
            limit: o.left[1],
            used: o.left[1] - o.left[0],
            remaining: o.left[0],
            window: 'month',
            resets_at: now + 86400,
          },
        ]
      : [],
  };
  return e;
}

function plan(scopes: TokenPlanScope[]): TokenPlan {
  return { as_of: now, scopes };
}

function renderView(pointer?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <TokenPlanView pointer={pointer} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('TokenPlanView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.endpoints = [];
    h.me.mockResolvedValue(plan([meScope, teamScope, orgScope]));
    h.getUsage.mockResolvedValue({ series: [], totals: c({}), breakdown: {}, names: {} });
  });
  afterEach(() => cleanup());

  it('lands on me by default: headline, resets-in, path chips; no admin button', async () => {
    renderView(undefined);
    const hero = await screen.findByTestId('budget-hero');
    expect(within(hero).getByTestId('budget-headline').textContent).toBe('$1.80 left today');
    expect(within(hero).getByTestId('budget-resets').textContent).toMatch(/resets in 4 h|resets in 3 h 59 m/);
    expect(within(hero).getByTestId('budget-bar-cost_usd_per_day')).toBeTruthy();
    expect(within(hero).queryByTestId('set-budget')).toBeNull();
    expect(screen.queryByTestId('scope-path')).toBeNull();
    expect(screen.queryByTestId('members-table')).toBeNull();
  });

  it('the expert link opens the scope endpoint usage tab', async () => {
    renderView(undefined);
    await userEvent.click(await screen.findByTestId('expert-link'));
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, `${ME_EP}/usage`);
  });

  it('the tree lays sources under their parent with sponsor, left / limit, Allocate and Configure', async () => {
    h.endpoints = [
      ep(ORG_EP, 'Langware pool', [], 'organization', { allocate: true, left: [400, 500] }),
      ep(TEAM_EP, 'Team A', [ORG_EP], 'team', { allocate: true, left: [58, 100] }),
      ep(ME_EP, 'default-alice', [TEAM_EP], 'user', { mine: true, left: [1.8, 5] }),
    ];
    renderView(undefined);
    const tree = await screen.findByTestId('token-sources');
    const names = within(tree)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent ?? '');
    expect(names[0]).toContain('Langware pool');
    expect(names[1]).toContain('Team A');
    expect(names[2]).toContain('default-alice');
    expect(names[2]).toContain('yours');
    expect(names[1]).toContain('Team');
    expect(names[1]).toContain('$58.00');
    expect(within(tree).queryByTestId(`allocate-${ME_EP}`)).toBeNull();
    expect(within(tree).getByTestId(`allocate-${TEAM_EP}`)).toBeTruthy();
    expect(screen.queryByTestId('hidden-teams')).toBeNull();

    await userEvent.click(within(tree).getByRole('button', { name: 'Team A' }));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.TOKEN_PLAN, `llm_endpoint-${TEAM_EP}`);
    await userEvent.click(within(tree).getByTestId(`configure-${TEAM_EP}`));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, TEAM_EP);
  });

  it('teams without a budget are not sources: they are only counted', async () => {
    h.me.mockResolvedValue(plan([meScope, scope({ kind: 'team', id: 't9', name: 'Empty', endpoint_id: null })]));
    renderView(undefined);
    expect((await screen.findByTestId('hidden-teams')).textContent).toContain('1 teams without a budget');
    expect(screen.queryByText('Empty')).toBeNull();
  });

  it('the sponsor filter keeps matching rows and dims their ancestors', async () => {
    h.endpoints = [
      ep(ORG_EP, 'Langware pool', [], 'organization'),
      ep(TEAM_EP, 'Team A', [ORG_EP], 'team'),
      ep(ME_EP, 'default-alice', [TEAM_EP], 'user', { mine: true }),
    ];
    renderView(undefined);
    const tree = await screen.findByTestId('token-sources');
    await userEvent.click(within(screen.getByTestId('scope-bar')).getByRole('tab', { name: 'Team' }));
    expect(within(tree).getAllByRole('row')).toHaveLength(3);
    expect(within(tree).getByTestId(`source-row-${ORG_EP}`).style.opacity).toBe('0.45');
    expect(within(tree).queryByTestId(`source-row-${ME_EP}`)).toBeNull();
  });

  it('a tree pointer selects that source and shows its pool split', async () => {
    h.endpoints = [
      ep(TEAM_EP, 'Team A', [], 'team', { allocate: true, left: [58, 100] }),
      ep(ME_EP, 'default-alice', [TEAM_EP], 'user', { mine: true, left: [1.8, 5] }),
    ];
    renderView(`llm_endpoint-${TEAM_EP}`);
    expect((await screen.findByTestId('budget-headline')).textContent).toBe('$58.00 left this month');
    expect(screen.getByTestId('pool-split').textContent).toContain('default-alice');
  });

  it('Allocate opens the allocate dialog; Add new token source opens the endpoint dialog', async () => {
    h.endpoints = [ep(TEAM_EP, 'Team A', [], 'team', { allocate: true, left: [58, 100] })];
    renderView(undefined);
    await userEvent.click(await screen.findByTestId(`allocate-${TEAM_EP}`));
    expect(await screen.findByTestId('allocate-dialog')).toBeTruthy();
    expect(screen.getByTestId('allocate-target-member')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('add-token-source'));
    expect(await screen.findByTestId('endpoint-dialog')).toBeTruthy();
    await userEvent.click(screen.getByTestId('all-endpoints'));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS);
  });

  it('team scope for an admin: Set budget opens the sheet and the members table drills down, sorted by spend', async () => {
    h.getUsage.mockImplementation((_id, q) =>
      Promise.resolve({
        series: [],
        totals: c({}),
        breakdown: {
          [`llm_endpoint-${ME_EP}`]: c({ cost_usd: q.granularity === 'hour' ? 0.5 : 2 }),
          [`llm_endpoint-${OTHER_EP}`]: c({ cost_usd: q.granularity === 'hour' ? 1 : 9 }),
          '': c({ cost_usd: 100 }),
        },
        names: { [`llm_endpoint-${ME_EP}`]: 'Alice', [`llm_endpoint-${OTHER_EP}`]: 'Dana' },
      }),
    );
    renderView(`team/${TEAM_ID}`);
    const hero = await screen.findByTestId('budget-hero');
    expect(within(hero).getByTestId('budget-headline').textContent).toBe('$58.00 left this month');
    await userEvent.click(within(hero).getByTestId('set-budget'));
    expect(screen.getByTestId('sheet-open')).toBeTruthy();

    const table = await screen.findByTestId('members-table');
    await waitFor(() => expect(within(table).getAllByTestId(/member-row-/)).toHaveLength(2));
    const rows = within(table).getAllByTestId(/member-row-/);
    expect(rows[0].textContent).toContain('Dana');
    expect(rows[1].textContent).toContain('Alice');
    expect(rows[1].textContent).toContain('(you)');
    expect(h.getUsage).toHaveBeenCalledWith(TEAM_EP, expect.objectContaining({ by: 'child' }));
    await userEvent.click(rows[0]);
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, `${OTHER_EP}/usage`);
  });

  it('team scope for a non-admin: no Set budget, only my own member row', async () => {
    h.me.mockResolvedValue(plan([meScope, { ...teamScope, can_configure: false }, orgScope]));
    h.getUsage.mockResolvedValue({
      series: [],
      totals: c({}),
      breakdown: { [`llm_endpoint-${ME_EP}`]: c({ cost_usd: 2 }), [`llm_endpoint-${OTHER_EP}`]: c({ cost_usd: 9 }) },
      names: { [`llm_endpoint-${ME_EP}`]: 'Alice', [`llm_endpoint-${OTHER_EP}`]: 'Dana' },
    });
    renderView(`team/${TEAM_ID}`);
    const hero = await screen.findByTestId('budget-hero');
    expect(within(hero).queryByTestId('set-budget')).toBeNull();
    const table = await screen.findByTestId('members-table');
    await waitFor(() => expect(within(table).getAllByTestId(/member-row-/)).toHaveLength(1));
    expect(within(table).getByTestId(`member-row-${ME_EP}`).textContent).toContain('Alice');
  });

  it('org without an endpoint: setup for admins, "ask an admin" otherwise', async () => {
    renderView('org');
    const setup = await screen.findByTestId('scope-setup');
    expect(setup.textContent).toContain('No organization budget yet');
    expect(within(setup).queryByTestId('scope-setup-run')).toBeNull();
    cleanup();

    h.me.mockResolvedValue(plan([meScope, teamScope, { ...orgScope, can_configure: true }]));
    renderView('org');
    await userEvent.click(await screen.findByTestId('scope-setup-run'));
    // With the org's id: `setup` is an action ON the organization, so the caller names which one
    // and the hub checks their roles on that entity. An id-less call had no target to check.
    await waitFor(() => expect(h.setupOrg).toHaveBeenCalledWith('o'));
    expect(h.setupTeam).not.toHaveBeenCalled();
  });

  it('team without an endpoint runs the team setup with the team id', async () => {
    h.me.mockResolvedValue(plan([meScope, { ...teamScope, endpoint_id: null }, orgScope]));
    renderView(`team/${TEAM_ID}`);
    await userEvent.click(await screen.findByTestId('scope-setup-run'));
    await waitFor(() => expect(h.setupTeam).toHaveBeenCalledWith(TEAM_ID));
  });

  it('no budget anywhere: empty hero with Set budget only for admins', async () => {
    h.me.mockResolvedValue(plan([scope({ can_configure: false })]));
    renderView(undefined);
    const empty = await screen.findByTestId('budget-hero-empty');
    expect(empty.textContent).toContain('No budget set');
    expect(empty.textContent).toContain('Ask your team admin');
    expect(within(empty).queryByTestId('set-budget')).toBeNull();
    cleanup();

    h.me.mockResolvedValue(plan([scope({ can_configure: true })]));
    renderView(undefined);
    await userEvent.click(await screen.findByTestId('set-budget'));
    expect(screen.getByTestId('sheet-open')).toBeTruthy();
  });

  it('unlimited here but capped upstream reads as the parent cap', async () => {
    h.me.mockResolvedValue(
      plan([
        scope({
          path: [
            { endpoint_id: ME_EP, name: 'default-alice', kind: 'me' },
            { endpoint_id: TEAM_EP, name: 'Team A', kind: 'team' },
          ],
          headline: { key: 'cost_usd_per_day', used: 10, limit: 200, remaining: 190, resets_at: null, window: 'day' },
          remaining: [],
        }),
      ]),
    );
    renderView(undefined);
    const hero = await screen.findByTestId('budget-hero');
    expect(within(hero).getByTestId('budget-headline').textContent).toBe(
      'Unlimited here — Team A caps you at $200.00 today',
    );
  });

  it('typeid endpoint ids (what the hub sends) still resolve to my own member row', async () => {
    // `endpoint_id` is a typeid on the wire while a breakdown row resolves to a
    // bare uuid: compared raw, a non-admin matches nothing and the table is empty.
    const typed = (s: TokenPlanScope): TokenPlanScope => ({ ...s, endpoint_id: `llm_endpoint-${s.endpoint_id}` });
    h.me.mockResolvedValue(plan([typed(meScope), typed({ ...teamScope, can_configure: false }), orgScope]));
    h.getUsage.mockResolvedValue({
      series: [],
      totals: c({}),
      breakdown: { [`llm_endpoint-${ME_EP}`]: c({ cost_usd: 2 }), [`llm_endpoint-${OTHER_EP}`]: c({ cost_usd: 9 }) },
      names: { [`llm_endpoint-${ME_EP}`]: 'Alice', [`llm_endpoint-${OTHER_EP}`]: 'Dana' },
    });
    renderView(`team/${TEAM_ID}`);
    const table = await screen.findByTestId('members-table');
    await waitFor(() => expect(within(table).getAllByTestId(/member-row-/)).toHaveLength(1));
    const row = within(table).getByTestId(`member-row-${ME_EP}`);
    expect(row.textContent).toContain('Alice');
    expect(row.textContent).toContain('(you)');
  });

  it('shows an error line when the plan cannot be read', async () => {
    h.me.mockRejectedValue(new Error('403'));
    renderView(undefined);
    expect(await screen.findByTestId('token-plan-error')).toBeTruthy();
  });
});
