/**
 * `TokenPlanCard` (hub home) — headline + resets-in from the `me` scope,
 * click → the token plan view, skeleton while loading, hidden on error.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMUsageCounters, TokenPlan } from '@sdk';

import { ZERO_COUNTERS } from '@src/components/llm-endpoints/usage-math';

const h = vi.hoisted(() => ({ openPage: vi.fn(), me: vi.fn<() => Promise<unknown>>() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, tokenPlanService: { me: h.me, setupTeam: vi.fn(), setupOrg: vi.fn() } };
});
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage: h.openPage }, currentDock: { page: 'hub' } }),
}));

import { PageId, ViewType } from '@sdk';

import { TokenPlanCard } from '@src/components/token-plan/TokenPlanCard';

const c = (over: Partial<LLMUsageCounters>): LLMUsageCounters => ({ ...ZERO_COUNTERS, ...over });
const totals = { today: c({}), week: c({}), month: c({}), all: c({}) };
const now = Math.floor(Date.now() / 1000);

function plan(
  headline: TokenPlan['scopes'][number]['headline'],
  path: TokenPlan['scopes'][number]['path'] = [],
): TokenPlan {
  return {
    as_of: now,
    scopes: [
      {
        kind: 'me',
        id: 'u',
        name: 'Eran',
        endpoint_id: 'e',
        can_configure: false,
        path,
        headline,
        remaining: headline ? [headline] : [],
        totals,
        series: [{ day: '2026-08-17', cost_usd: 1, total_tokens: 10, requests: 1 }],
      },
    ],
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TokenPlanCard />
    </QueryClientProvider>,
  );
}

describe('TokenPlanCard', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('shows the headline with resets-in and opens the token plan on click', async () => {
    h.me.mockResolvedValue(
      plan({ key: 'cost_usd_per_day', used: 3.2, limit: 5, remaining: 1.8, resets_at: now + 4 * 3600, window: 'day' }),
    );
    renderCard();
    expect(screen.getByTestId('hub-home-token-plan-loading')).toBeTruthy();
    const card = await screen.findByTestId('hub-home-token-plan');
    const text = screen.getByTestId('hub-home-token-plan-headline').textContent ?? '';
    expect(text).toContain('$1.80 left today');
    expect(text).toMatch(/resets in (4 h|3 h 59 m)/);
    await userEvent.click(card);
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.TOKEN_PLAN);
  });

  it('with no cap it says where spend draws from', async () => {
    h.me.mockResolvedValue(
      plan(null, [
        { endpoint_id: 'e', name: 'default-eran', kind: 'me' },
        { endpoint_id: 't', name: 'Team A', kind: 'team' },
      ]),
    );
    renderCard();
    expect((await screen.findByTestId('hub-home-token-plan-headline')).textContent).toBe(
      'No limit — draws from Team A',
    );
  });

  it('is hidden when the plan cannot be read', async () => {
    h.me.mockRejectedValue(new Error('403'));
    renderCard();
    await waitFor(() => expect(screen.queryByTestId('hub-home-token-plan-loading')).toBeNull());
    expect(screen.queryByTestId('hub-home-token-plan')).toBeNull();
  });
});
