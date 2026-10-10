/**
 * `useHubRemaining` — one chain read per DISTINCT hub endpoint, nothing for the others.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import type { LLMChain, LLMFundingStatus } from '@sdk';

const h = vi.hoisted(() => ({ getChain: vi.fn<(id: string) => Promise<LLMChain>>() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, llmSourcesService: { chain: h.getChain, testSource: vi.fn(), select: vi.fn() } };
});
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => false }));

import { hubEndpointTypeIds, useHubRemaining } from '@src/components/llm-sources/use-hub-remaining';

const HUB_ID = '00000000-0000-4000-8000-000000000003';
const HUB = `llm_endpoint-${HUB_ID}`;
const DEVICE = 'llm_endpoint-00000000-0000-4000-8000-000000000001';

const funding = {
  available: [{ id: HUB_ID, name: 'eran default', kind: 'hub' }],
  resolved: { 'harness.claude.cli': { endpoint_typeid: HUB }, 'harness.codex.cli': { endpoint_typeid: DEVICE } },
  endpoints: { [HUB]: { id: HUB_ID, kind: 'hub' }, [DEVICE]: { id: 'd', kind: 'device' } },
} as unknown as LLMFundingStatus;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useHubRemaining', () => {
  it('lists each hub endpoint once, from resolved and available, and skips device/key ones', () => {
    expect(hubEndpointTypeIds(funding)).toEqual([HUB]);
  });

  it('in-use scope reads only what a harness is spending, not every endpoint on offer', () => {
    const OTHER = '00000000-0000-4000-8000-000000000009';
    const more = { ...funding, available: [...funding.available, { id: OTHER, name: 'idle', kind: 'hub' }] } as LLMFundingStatus;
    expect(hubEndpointTypeIds(more, 'all')).toEqual([HUB, `llm_endpoint-${OTHER}`]);
    expect(hubEndpointTypeIds(more, 'in-use')).toEqual([HUB]);
  });

  it('fetches the chain once per hub endpoint and reports its tightest cost cap', async () => {
    h.getChain.mockResolvedValue({
      entry: { id: HUB_ID, name: 'x' },
      dim: '',
      hops: [
        {
          id: HUB_ID, name: 'x', provider: 'openrouter', is_root: true, has_credential: true, enabled: true,
          breaker: { state: 'closed', open_until: null }, limits: {}, effective_filters: {},
          remaining: { cost_usd_total: { limit: 3, used: 0.42, remaining: 2.58, window: 'total', resets_at: null } },
        },
      ],
    } as unknown as LLMChain);
    const { result } = renderHook(() => useHubRemaining(funding), { wrapper });
    await waitFor(() => expect(result.current[HUB]?.remaining.remaining).toBe(2.58));
    expect(result.current[HUB]?.key).toBe('cost_usd_total');
    expect(h.getChain).toHaveBeenCalledTimes(1);
    expect(h.getChain).toHaveBeenCalledWith(HUB_ID);
  });
});
