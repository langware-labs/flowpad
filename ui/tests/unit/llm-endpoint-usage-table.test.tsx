/**
 * `UsageByChildTable` — the drill-down: a child row navigates to that
 * endpoint's Usage tab on the hub page (`openPage(HUB, LLM_ENDPOINTS,
 * '<child>/usage')`); the "direct" row and model rows do not navigate.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ openPage: vi.fn(), openDock: vi.fn() }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openPage: h.openPage, openDock: h.openDock },
    currentDock: { page: 'hub' },
  }),
}));

import { LLMEndpoint, PageId, ViewType, type LLMUsageCounters } from '@sdk';

import { UsageByChildTable } from '@src/components/llm-endpoints/UsageByChildTable';
import { ZERO_COUNTERS } from '@src/components/llm-endpoints/usage-math';

const CHILD = 'abcdef00-0000-4000-8000-000000000000';
const c = (over: Partial<LLMUsageCounters>): LLMUsageCounters => ({ ...ZERO_COUNTERS, ...over });

describe('UsageByChildTable', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('names child rows and drills into the child usage tab on click', async () => {
    const child = new LLMEndpoint({ id: CHILD, name: 'Team chain' });
    render(
      <UsageByChildTable
        by="child"
        breakdown={{
          [`llm_endpoint-${CHILD}`]: c({ requests: 5, cost_usd: 1.5, total_tokens: 5000 }),
          '': c({ requests: 1, cost_usd: 0.1, total_tokens: 100 }),
        }}
        all={[child]}
      />,
    );

    const row = screen.getByTestId(`usage-row-llm_endpoint-${CHILD}`);
    expect(row.textContent).toContain('Team chain');
    await userEvent.click(row);
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, `${CHILD}/usage`);
    expect(h.openDock).not.toHaveBeenCalled();
  });

  it('the direct row is not a link', async () => {
    render(<UsageByChildTable by="child" breakdown={{ '': c({ requests: 1 }) }} all={[]} />);
    const row = screen.getByTestId('usage-row-direct');
    expect(row.textContent).toContain('direct');
    await userEvent.click(row);
    expect(h.openPage).not.toHaveBeenCalled();
  });

  it('model rows never navigate', async () => {
    render(<UsageByChildTable by="model" breakdown={{ 'anthropic/claude-3-5': c({ requests: 2 }) }} all={[]} />);
    await userEvent.click(screen.getByTestId('usage-row-anthropic/claude-3-5'));
    expect(h.openPage).not.toHaveBeenCalled();
  });

  it('sorts by cost, highest first, and falls back to the id for unknown children', () => {
    render(
      <UsageByChildTable
        by="child"
        breakdown={{
          'llm_endpoint-cheap': c({ cost_usd: 0.1 }),
          'llm_endpoint-pricey': c({ cost_usd: 9 }),
        }}
        all={[]}
      />,
    );
    const rows = screen.getAllByTestId(/usage-row-/).map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('llm_endpoint-pricey');
    expect(rows[1]).toContain('llm_endpoint-cheap');
  });

  it("the hub's names map names children the caller cannot list", () => {
    const dim = `llm_endpoint-${CHILD}`;
    render(
      <UsageByChildTable by="child" breakdown={{ [dim]: c({ cost_usd: 1 }) }} names={{ [dim]: 'Dana' }} all={[]} />,
    );
    expect(screen.getByTestId(`usage-row-${dim}`).textContent).toContain('Dana');
  });
});
