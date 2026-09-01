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
vi.mock('@src/components/token-plan/SetBudgetSheet', () => ({
  SetBudgetSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="sheet-open" /> : null),
}));

import { PageId, ViewType } from '@sdk';

import { TokenPlanView } from '@src/components/token-plan/TokenPlanView';

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
    name: 'Eran',
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
    { endpoint_id: ME_EP, name: 'default-eran', kind: 'me' },
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

function plan(scopes: TokenPlanScope[]): TokenPlan {
  return { as_of: now, scopes };
}

function renderView(pointer?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TokenPlanView pointer={pointer} />
    </QueryClientProvider>,
  );
}

describe('TokenPlanView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const path = screen.getByTestId('scope-path');
    expect(path.textContent).toContain('default-eran');
    expect(path.textContent).toContain('Team A');
    expect(path.textContent).toContain('Langware');
    expect(screen.queryByTestId('members-table')).toBeNull();
  });

  it('a path chip opens that hop on the expert page', async () => {
    renderView(undefined);
    await screen.findByTestId('scope-path');
    await userEvent.click(screen.getByTestId(`path-chip-${TEAM_EP}`));
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, TEAM_EP);
  });

  it('the expert link opens the scope endpoint usage tab', async () => {
    renderView(undefined);
    await userEvent.click(await screen.findByTestId('expert-link'));
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, `${ME_EP}/usage`);
  });

  it('switching scope navigates by pointer (team/<id>, org, back to me = no pointer)', async () => {
    renderView(undefined);
    const bar = await screen.findByTestId('scope-bar');
    await userEvent.click(within(bar).getByRole('button', { name: 'Team A' }));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.TOKEN_PLAN, `team/${TEAM_ID}`);
    await userEvent.click(within(bar).getByRole('button', { name: 'Langware' }));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.TOKEN_PLAN, 'org');
    await userEvent.click(within(bar).getByRole('button', { name: 'Me' }));
    expect(h.openPage).toHaveBeenLastCalledWith(PageId.HUB, ViewType.TOKEN_PLAN, undefined);
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
        names: { [`llm_endpoint-${ME_EP}`]: 'Eran', [`llm_endpoint-${OTHER_EP}`]: 'Dana' },
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
    expect(rows[1].textContent).toContain('Eran');
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
      names: { [`llm_endpoint-${ME_EP}`]: 'Eran', [`llm_endpoint-${OTHER_EP}`]: 'Dana' },
    });
    renderView(`team/${TEAM_ID}`);
    const hero = await screen.findByTestId('budget-hero');
    expect(within(hero).queryByTestId('set-budget')).toBeNull();
    const table = await screen.findByTestId('members-table');
    await waitFor(() => expect(within(table).getAllByTestId(/member-row-/)).toHaveLength(1));
    expect(within(table).getByTestId(`member-row-${ME_EP}`).textContent).toContain('Eran');
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
    await waitFor(() => expect(h.setupOrg).toHaveBeenCalledTimes(1));
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
    expect(screen.queryByTestId('scope-bar')).toBeNull();
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
            { endpoint_id: ME_EP, name: 'default-eran', kind: 'me' },
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
      names: { [`llm_endpoint-${ME_EP}`]: 'Eran', [`llm_endpoint-${OTHER_EP}`]: 'Dana' },
    });
    renderView(`team/${TEAM_ID}`);
    const table = await screen.findByTestId('members-table');
    await waitFor(() => expect(within(table).getAllByTestId(/member-row-/)).toHaveLength(1));
    const row = within(table).getByTestId(`member-row-${ME_EP}`);
    expect(row.textContent).toContain('Eran');
    expect(row.textContent).toContain('(you)');
  });

  it('shows an error line when the plan cannot be read', async () => {
    h.me.mockRejectedValue(new Error('403'));
    renderView(undefined);
    expect(await screen.findByTestId('token-plan-error')).toBeTruthy();
  });
});
