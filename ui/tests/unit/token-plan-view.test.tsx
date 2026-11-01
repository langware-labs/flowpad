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
const FLOWPAD = '7f1c9d2e-0000-4a00-8000-11e0e0e0e0e0';
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
  o: { allocate?: boolean; mine?: boolean; left?: [number, number]; owner?: boolean; key?: boolean } = {},
): LLMEndpoint {
  const e = new LLMEndpoint({ id, name, credential_hint: o.key ? '****e2da' : '' } as never);
  e.expand = {
    roles: (o.owner ? ['owner'] : ['reader']) as never,
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

  it('with nothing selected the centre sums every source', async () => {
    h.endpoints = [
      ep(ORG_EP, 'worker root', [], 'user', { owner: true, key: true, allocate: true }),
      ep(ME_EP, 'default-alice', [FLOWPAD], 'user', { mine: true, left: [1.8, 5] }),
    ];
    h.getUsage.mockImplementation((id: string) =>
      Promise.resolve({
        series: [],
        totals: c({ cost_usd: id === ME_EP ? 0.25 : 0.5, requests: 2 }),
        breakdown: {},
        names: {},
      }),
    );
    renderView(undefined);
    expect((await screen.findByTestId('summary-title')).textContent).toBe('All sources');
    expect(screen.getByTestId('budget-headline').textContent).toBe('$1.80 left of $5.00');
    await waitFor(() => expect(screen.getByTestId('consumption-cost').textContent).toContain('$0.75'));
    expect(screen.getByTestId('consumption-requests').textContent).toContain('4');
    expect(screen.getByTestId(`breakdown-${ME_EP}`).textContent).toContain('Flowpad account');
    expect(screen.queryByTestId('show-all')).toBeNull();
  });

  it('a selected row keeps the same layout: its budget, its usage, what was allocated from it', async () => {
    h.endpoints = [
      ep(TEAM_EP, 'Team A', [], 'team', { owner: true, key: true, allocate: true, left: [58, 100] }),
      ep(ME_EP, 'default-alice', [TEAM_EP], 'user', { owner: true, left: [1.8, 5] }),
    ];
    renderView(`llm_endpoint-${TEAM_EP}`);
    expect((await screen.findByTestId('summary-title')).textContent).toBe('Team A');
    expect(screen.getByTestId('budget-headline').textContent).toBe('$58.00 left of $100.00');
    expect(screen.getByTestId(`breakdown-${ME_EP}`).textContent).toContain('default-alice');
    await userEvent.click(screen.getByTestId('expert-link'));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, `${TEAM_EP}/usage`);
    await userEvent.click(screen.getByTestId('show-all'));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.TOKEN_PLAN, undefined);
  });

  it('lists only root token sources: your keys and what you received; allocations stay out', async () => {
    h.endpoints = [
      ep(ORG_EP, 'worker root', [], 'user', { owner: true, key: true, allocate: true }),
      ep(TEAM_EP, 'claude budget', [ORG_EP], 'user', { owner: true, allocate: true, left: [1, 1] }),
      ep(ME_EP, 'default-alice', [FLOWPAD], 'user', { mine: true, left: [1.8, 5] }),
      ep(OTHER_EP, 'dead root', [], 'user', { owner: true }),
    ];
    renderView(undefined);
    const tree = await screen.findByTestId('token-sources');
    expect(within(tree).queryByTestId(`source-row-${TEAM_EP}`)).toBeNull();
    const count = within(tree).getByTestId(`allocated-count-${ORG_EP}`);
    expect(count.textContent).toBe('1 allocation');
    await userEvent.click(count);
    expect(within(tree).getByTestId(`source-row-${TEAM_EP}`).textContent).toContain('claude budget');
    expect(within(tree).getByTestId(`source-type-${TEAM_EP}`).textContent).toBe('Allocation');
    await userEvent.click(count);
    expect(within(tree).queryByTestId(`source-row-${TEAM_EP}`)).toBeNull();
    expect(within(tree).getByTestId(`source-type-${ME_EP}`).textContent).toBe('Flowpad account');
    expect(within(tree).getByTestId(`source-row-${ME_EP}`).textContent).toContain('Flowpad account');
    expect(within(tree).getByTestId(`source-type-${ORG_EP}`).textContent).toBe('API key ••e2da');
    expect(within(tree).getByTestId(`source-type-${OTHER_EP}`).textContent).toBe('No key');
    expect(within(tree).queryByTestId(`allocate-${OTHER_EP}`)).toBeNull();
    expect(within(tree).getByTestId(`allocate-${ORG_EP}`)).toBeTruthy();
    expect(within(tree).queryByTestId(`allocate-${ME_EP}`)).toBeNull();

    await userEvent.click(within(tree).getByRole('button', { name: 'worker root' }));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.TOKEN_PLAN, `llm_endpoint-${ORG_EP}`);
    await userEvent.click(within(tree).getByTestId(`configure-${ORG_EP}`));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, ORG_EP);
  });

  it('teams without a budget are not sources: they are only counted', async () => {
    h.me.mockResolvedValue(plan([meScope, scope({ kind: 'team', id: 't9', name: 'Empty', endpoint_id: null })]));
    renderView(undefined);
    expect((await screen.findByTestId('hidden-teams')).textContent).toContain('1 teams without a budget');
    expect(screen.queryByText('Empty')).toBeNull();
  });

  it('Allocate opens the allocate dialog; Add new token source opens the endpoint dialog', async () => {
    h.endpoints = [ep(TEAM_EP, 'Team A', [], 'team', { owner: true, key: true, allocate: true, left: [58, 100] })];
    renderView(undefined);
    await userEvent.click(await screen.findByTestId(`allocate-${TEAM_EP}`));
    expect(await screen.findByTestId('allocate-dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('add-token-source'));
    expect(await screen.findByTestId('endpoint-dialog')).toBeTruthy();
    await userEvent.click(screen.getByTestId('all-endpoints'));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS);
  });

  it('shows an error line when the plan cannot be read', async () => {
    h.me.mockRejectedValue(new Error('403'));
    renderView(undefined);
    expect(await screen.findByTestId('token-plan-error')).toBeTruthy();
  });
  it('a row shows the model each size runs, inherited down its chain', async () => {
    const mine = ep(ME_EP, 'default-alice', [TEAM_EP], 'user', { mine: true, left: [1.8, 5] });
    mine.expand = {
      ...mine.expand,
      tiers: { sm: 'google/gemini-3.1-flash-lite', md: 'google/gemini-3.1-pro-preview', lg: null },
    };
    h.endpoints = [mine];
    renderView(undefined);
    const chip = await screen.findByTestId(`sizes-${ME_EP}`);
    expect(chip.textContent).toBe('sm gemini-3.1-flash-lite · md gemini-3.1-pro-preview');
    expect(chip.getAttribute('title')).toContain('md: google/gemini-3.1-pro-preview');
  });
});
