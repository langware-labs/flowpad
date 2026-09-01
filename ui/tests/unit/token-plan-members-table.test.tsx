/**
 * `MembersTable` regression locks.
 *
 * The plan's `scope.endpoint_id` is a TYPEID (`llm_endpoint-<uuid>`) while entity
 * action URLs take the bare uuid — a typeid in the path answers 422, which left
 * "Who's spending" permanently empty. And the hub's `names` map can come back
 * empty (its in-request re-read of a child is denied under the `usage` action),
 * so a row must still be labelled from the endpoints the caller can list rather
 * than showing a raw typeid.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const DIM = `llm_endpoint-${UUID}`;

const h = vi.hoisted(() => ({
  getUsage: vi.fn(),
  endpoints: [] as unknown[],
  openPage: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    llmEndpointsService: { ...(actual.llmEndpointsService as object), getUsage: h.getUsage },
  };
});
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage: h.openPage }, currentDock: { page: 'hub' } }),
}));
vi.mock('@src/components/llm-endpoints/use-llm-endpoints', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLlmEndpoints: () => ({ endpoints: h.endpoints, isLoading: false, refetch: vi.fn(), error: null }),
}));

import { MembersTable, memberRows } from '@src/components/token-plan/MembersTable';

const counters = (cost: number) => ({
  requests: 1,
  fallbacks: 0,
  errors: 0,
  input_tokens: 11,
  output_tokens: 5,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: cost,
  latency_ms_sum: 0,
  ttfb_ms_sum: 0,
  estimated_requests: 0,
  unpriced_requests: 0,
  total_tokens: 16,
});

const report = (names: Record<string, string> = {}) => ({
  series: [],
  totals: counters(0.000036),
  granularity: 'day' as const,
  breakdown: { [DIM]: counters(0.000036) },
  names,
});

function renderTable(props: Partial<React.ComponentProps<typeof MembersTable>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MembersTable endpointId={`llm_endpoint-${'11111111-1111-4111-8111-111111111111'}`} canConfigure {...props} />
    </QueryClientProvider>,
  );
}

describe('memberRows', () => {
  it('labels a row from the endpoints list when the hub sends no names', () => {
    const rows = memberRows(report(), report(), undefined, (id) => (id === UUID ? 'alice default' : undefined));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('alice default');
    expect(rows[0].id).toBe(UUID);
  });

  it("prefers the hub's name over the local lookup", () => {
    const rows = memberRows(report({ [DIM]: 'from hub' }), undefined, undefined, () => 'from list');
    expect(rows[0].name).toBe('from hub');
  });

  it('falls back to the raw dim only when nothing can name it', () => {
    expect(memberRows(report(), undefined)[0].name).toBe(DIM);
  });
});

describe('MembersTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.endpoints.length = 0;
    h.getUsage.mockResolvedValue(report());
  });
  afterEach(() => cleanup());

  it('queries usage with the BARE uuid — a typeid in the path answers 422', async () => {
    renderTable();
    await screen.findByTestId('members-table');
    expect(h.getUsage).toHaveBeenCalled();
    for (const [id] of h.getUsage.mock.calls) {
      expect(id).toBe('11111111-1111-4111-8111-111111111111');
      expect(String(id)).not.toContain('llm_endpoint-');
    }
  });
});
