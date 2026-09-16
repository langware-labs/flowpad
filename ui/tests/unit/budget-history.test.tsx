/**
 * The budget history screen.
 *
 * What is pinned here is what the trail is FOR: the three kinds of event read differently, an
 * amount is a move (`before → after`) when a cap changed and a single figure when money was handed
 * out, and an uncapped allowance never prints as `$0` — that would report the most permissive
 * budget in the system as the tightest one.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const EP = (n: number) => `llm_endpoint-${UUID(n)}`;

const h = vi.hoisted(() => ({ getHistory: vi.fn() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    llmEndpointsService: { getHistory: (...args: unknown[]) => h.getHistory(...args) },
  };
});

import { BudgetHistoryDialog } from '@src/components/organization/budgets/BudgetHistoryDialog';

const row = (over: Record<string, unknown> = {}) => ({
  id: UUID(9),
  event: 'allocated',
  ts: 1_788_000_000,
  endpoint_typeid: EP(2),
  endpoint_name: 'ishay@langware.ai default',
  source_typeid: EP(1),
  beneficiary_typeid: `user-${UUID(3)}`,
  beneficiary_name: 'Ishay Sela',
  actor_typeid: `user-${UUID(3)}`,
  actor_name: 'Ishay Sela',
  limits_before: null,
  limits_after: { cost_usd_total: 3 },
  member_default_limits_before: null,
  member_default_limits_after: null,
  spent_usd: 0,
  spent_tokens: 0,
  ...over,
});

function draw(endpointId = EP(1)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BudgetHistoryDialog open onOpenChange={vi.fn()} endpointId={endpointId} scopeLabel="Begin School" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BudgetHistoryDialog', () => {
  it('shows who was given how much, and by whom', async () => {
    h.getHistory.mockResolvedValue([row()]);

    draw();

    await waitFor(() => expect(screen.getByTestId(`budget-history-row-${UUID(9)}`)).toBeTruthy());
    const text = screen.getByTestId(`budget-history-row-${UUID(9)}`).textContent ?? '';
    expect(text).toContain('given');
    expect(text).toContain('ishay@langware.ai default');
    expect(text).toContain('Ishay Sela');
    expect(text).toContain('$3.00');
  });

  it('reads a raise as a move, not as a number that was always that', async () => {
    h.getHistory.mockResolvedValue([
      row({ event: 'limits_changed', limits_before: { cost_usd_total: 3 }, limits_after: { cost_usd_total: 50 } }),
    ]);

    draw();

    await waitFor(() => expect(screen.getByTestId(`budget-history-row-${UUID(9)}`)).toBeTruthy());
    expect(screen.getByTestId(`budget-history-row-${UUID(9)}`).textContent).toContain('$3.00 → $50.00');
  });

  it('carries what a removed allowance had already spent', async () => {
    h.getHistory.mockResolvedValue([
      row({ event: 'deleted', limits_before: { cost_usd_total: 1 }, limits_after: null, spent_usd: 0.75 }),
    ]);

    draw();

    await waitFor(() => expect(screen.getByTestId(`budget-history-row-${UUID(9)}`)).toBeTruthy());
    const text = screen.getByTestId(`budget-history-row-${UUID(9)}`).textContent ?? '';
    expect(text).toContain('removed');
    expect(text).toContain('$0.75');
  });

  it('never prints an uncapped allowance as $0', async () => {
    // `null` is unbounded. Showing "$0" would read as the tightest budget on the page when it is
    // the loosest one there is.
    h.getHistory.mockResolvedValue([row({ limits_after: { cost_usd_total: null } })]);

    draw();

    await waitFor(() => expect(screen.getByTestId(`budget-history-row-${UUID(9)}`)).toBeTruthy());
    // The AMOUNT cell specifically: "Spent then" is legitimately $0 on a wallet nobody has used,
    // so asserting on the whole row would pass for the wrong reason.
    const cells = screen.getByTestId(`budget-history-row-${UUID(9)}`).querySelectorAll('td');
    expect(cells[5].textContent).toBe('—');
  });

  it('asks the hub with the bare uuid, not the typeid', async () => {
    // An action URL takes the uuid; a typeid in the path answers 422.
    h.getHistory.mockResolvedValue([]);

    draw(EP(1));

    await waitFor(() => expect(h.getHistory).toHaveBeenCalledWith(UUID(1)));
  });

  it('says so when there is nothing recorded yet', async () => {
    h.getHistory.mockResolvedValue([]);

    draw();

    await waitFor(() => expect(screen.getByTestId('budget-history-table')).toBeTruthy());
    expect(screen.getByText(/Nothing has been given out/)).toBeTruthy();
  });

  it('shows a refusal instead of an empty table', async () => {
    h.getHistory.mockRejectedValue(new Error('Unauthorized'));

    draw();

    await waitFor(() => expect(screen.getByTestId('budget-history-error')).toBeTruthy());
  });
});
