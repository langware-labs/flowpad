import { TypeId } from '@sdk';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ endpoint: null as unknown, scope: null as unknown }));

vi.mock('@src/components/llm-endpoints/use-llm-endpoints', () => ({ useLlmEndpoint: () => h.endpoint }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: h.scope }) }));

import { useLiveBudget } from '@src/components/organization/budgets/use-live-budget';

const row = { name: 'from server', limit_usd: 5 as number | null, endpoint_id: 'llm_endpoint-1' };

describe('useLiveBudget', () => {
  beforeEach(() => {
    h.endpoint = null;
    h.scope = null;
  });

  it('shows the server row until the entity has loaded', () => {
    const { result } = renderHook(() => useLiveBudget(row));
    expect(result.current).toEqual(row);
  });

  it("follows the person's endpoint for name and cap", () => {
    h.endpoint = { name: 'renamed', limits: { cost_usd_total: 9 } };
    const { result } = renderHook(() => useLiveBudget(row));
    expect(result.current).toMatchObject({ name: 'renamed', limit_usd: 9 });
  });

  it('reads an uncapped endpoint as null, not as the server value', () => {
    h.endpoint = { name: 'x', limits: { cost_usd_total: null } };
    const { result } = renderHook(() => useLiveBudget(row));
    expect(result.current?.limit_usd).toBeNull();
  });

  it('takes a scope row name from the team entity, not from its pool endpoint', () => {
    h.endpoint = { name: 'AI Course budget', limits: { cost_usd_total: 70 } };
    h.scope = { name: 'AI Course (renamed)' };
    const { result } = renderHook(() => useLiveBudget(row, new TypeId('team', '270d0fbb-a54f-4170-b898-c70e0e97a138')));
    expect(result.current).toMatchObject({ name: 'AI Course (renamed)', limit_usd: 70 });
  });

  it('passes an absent row through', () => {
    const { result } = renderHook(() => useLiveBudget(undefined));
    expect(result.current).toBeUndefined();
  });
});
