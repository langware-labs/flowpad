import { ConnectionManager, Skill, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssetStats } from '@src/hooks/use-asset-stats';

// Minimal consumer that renders the skill count from the hook.
function SkillCount() {
  const { stats } = useAssetStats();
  return <div data-testid="count">{stats.per_type.skill ?? 0}</div>;
}

describe('useAssetStats — counts react to asset CREATE data_op', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => cleanup());

  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('refetches and bumps the count when a skill CREATE op is broadcast', async () => {
    // First fetch → 1 skill; any later fetch (after invalidation) → 2.
    const getSpy = vi.spyOn(apiClient, 'get');
    getSpy.mockResolvedValueOnce({ per_type: { skill: 1 }, total: 1 } as never);
    getSpy.mockResolvedValue({ per_type: { skill: 2 }, total: 2 } as never);

    render(<SkillCount />, { wrapper: Wrapper });

    await vi.waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));

    // A skill is created elsewhere → backend broadcasts a CREATE data_op.
    ConnectionManager.getInstance().emit(
      'on_data_op',
      new TypeId(Skill.type, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc').toString(),
      'create',
      { type: 'skill' } as never,
    );

    // The hook's useEntityOps subscription invalidates ['asset-stats'] → refetch.
    await vi.waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
  });
});
