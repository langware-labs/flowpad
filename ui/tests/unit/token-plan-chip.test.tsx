/**
 * `TokenPlanChip` (harness modal) — the same wording as the hero and the home
 * card, through the one `headlineFor`: the short budget form normally, the
 * upstream cap when this scope is unlimited but its path is not, "no budget"
 * when nothing caps me, and nothing at all when the plan cannot be read.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMUsageCounters, TokenPlan, TokenPlanScope } from '@sdk';

import { ZERO_COUNTERS } from '@src/components/llm-endpoints/usage-math';

const h = vi.hoisted(() => ({ me: vi.fn<() => Promise<unknown>>() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, tokenPlanService: { me: h.me, setupTeam: vi.fn(), setupOrg: vi.fn() } };
});

import { TokenPlanChip } from '@src/components/token-plan/TokenPlanChip';

const c = (over: Partial<LLMUsageCounters>): LLMUsageCounters => ({ ...ZERO_COUNTERS, ...over });
const now = Math.floor(Date.now() / 1000);

function plan(over: Partial<TokenPlanScope>): TokenPlan {
  return {
    as_of: now,
    scopes: [
      {
        kind: 'me',
        id: 'u',
        name: 'Eran',
        endpoint_id: 'llm_endpoint-e',
        can_configure: false,
        path: [],
        headline: null,
        remaining: [],
        totals: { today: c({}), week: c({}), month: c({}), all: c({}) },
        series: [],
        ...over,
      },
    ],
  };
}

function renderChip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TokenPlanChip />
    </QueryClientProvider>,
  );
}

describe('TokenPlanChip', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('shows the short budget form', async () => {
    const headline = { key: 'cost_usd_per_day', used: 3.2, limit: 5, remaining: 1.8, resets_at: null, window: 'day' };
    h.me.mockResolvedValue(plan({ headline, remaining: [headline] }));
    renderChip();
    expect((await screen.findByTestId('token-plan-chip')).textContent).toBe('your budget: $3.20 of $5.00 today');
  });

  it('says who caps me when I am unlimited here but capped upstream', async () => {
    h.me.mockResolvedValue(
      plan({
        headline: { key: 'cost_usd_per_day', used: 10, limit: 200, remaining: 190, resets_at: null, window: 'day' },
        remaining: [],
        path: [
          { endpoint_id: 'me', name: 'default-eran', kind: 'me' },
          { endpoint_id: 't', name: 'Team A', kind: 'team' },
        ],
      }),
    );
    renderChip();
    expect((await screen.findByTestId('token-plan-chip')).textContent).toBe(
      'Unlimited here — Team A caps you at $200.00 today',
    );
  });

  it('reads as no budget when nothing caps me anywhere', async () => {
    h.me.mockResolvedValue(plan({}));
    renderChip();
    expect((await screen.findByTestId('token-plan-chip')).textContent).toBe('no budget');
  });

  it('renders nothing when the plan cannot be read', async () => {
    h.me.mockRejectedValue(new Error('403'));
    renderChip();
    await waitFor(() => expect(screen.queryByTestId('token-plan-chip')).toBeNull());
  });
});
