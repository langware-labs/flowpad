/**
 * The budgets reads ask the hub's `can_read_budgets` first: a plain member's org page sends no
 * budgets read the hub would refuse (that refusal used to surface as "Cloud Request Failed").
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ myScopes: vi.fn(), orgBudgets: vi.fn() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, budgetsService: { myScopes: h.myScopes, orgBudgets: h.orgBudgets } };
});

import { useOrgBudgets } from '@src/components/organization/budgets/use-budgets';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useOrgBudgets', () => {
  it('never asks for budgets the hub said this caller may not read', async () => {
    h.myScopes.mockResolvedValue([{ type: 'organization', id: 'org-1', roles: ['reader'], can_read_budgets: false }]);
    const { result } = renderHook(() => useOrgBudgets('org-1'), { wrapper });

    await waitFor(() => expect(result.current.refused).toBe(true));
    expect(h.orgBudgets).not.toHaveBeenCalled();
  });

  it('reads them when the hub says yes, or does not know the org yet', async () => {
    h.myScopes.mockResolvedValue([{ type: 'organization', id: 'org-1', roles: ['owner'], can_read_budgets: true }]);
    h.orgBudgets.mockResolvedValue({ org: { id: 'org-1' }, teams: [], people: [] });
    const { result } = renderHook(() => [useOrgBudgets('org-1'), useOrgBudgets('org-new')], { wrapper });

    await waitFor(() => expect(result.current[0].data).toBeTruthy());
    expect(h.orgBudgets).toHaveBeenCalledWith('org-1');
    expect(h.orgBudgets).toHaveBeenCalledWith('org-new');
  });
});
