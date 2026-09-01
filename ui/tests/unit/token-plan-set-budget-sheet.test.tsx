/**
 * `SetBudgetSheet` — it resolves the scope endpoint itself, from the TYPEID the
 * hub sends (`llm_endpoint-<uuid>`) against the entity's bare `id`. Compared
 * raw the two never match, the sheet opens with no endpoint and Save stays
 * disabled forever; `useLlmEndpoint` normalises both sides.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EP = 'aaaaaaaa-0000-4000-8000-000000000000';

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useEntitiesQuery: () => ({ data: h.rows, isLoading: false, refetch: vi.fn(), error: null }),
}));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    llmEndpointsService: { ...(actual.llmEndpointsService as object), listShared: () => Promise.resolve([]) },
  };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

import { LLMEndpoint } from '@sdk';

import { SetBudgetSheet } from '@src/components/token-plan/SetBudgetSheet';

function renderSheet(endpointId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SetBudgetSheet open onOpenChange={vi.fn()} endpointId={endpointId} scopeKind="team" scopeName="Team A" />
    </QueryClientProvider>,
  );
}

describe('SetBudgetSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.rows = [new LLMEndpoint({ id: EP, name: 'Team A pool' })];
  });
  afterEach(() => cleanup());

  it('resolves the endpoint from a typeid, so Save is live', async () => {
    renderSheet(`llm_endpoint-${EP}`);
    expect((await screen.findByTestId('budget-save')).hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('member-default-limits')).toBeTruthy();
  });

  it('resolves a bare uuid just the same', async () => {
    renderSheet(EP);
    expect((await screen.findByTestId('budget-save')).hasAttribute('disabled')).toBe(false);
  });

  it('keeps Save disabled while no endpoint matches', async () => {
    renderSheet('llm_endpoint-bbbbbbbb-0000-4000-8000-000000000000');
    expect((await screen.findByTestId('budget-save')).hasAttribute('disabled')).toBe(true);
  });
});
