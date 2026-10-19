/**
 * A budget row with its live name and cap laid over it.
 *
 * The budgets read is a server-built aggregate: one slow call (~10s after a write, it fans out per
 * person) that carries every name and cap on the page. The entities themselves are live — a save
 * updates the cached `LLMEndpoint` / `Team` / `Organization` and notifies its subscribers at once.
 * So the row's name and cap are read from the entity, and the aggregate only fills in until the
 * entity has loaded. Nothing here is written by hand after a save; the page follows the entity.
 *
 * Name: the person's own endpoint (what the owner typed), or the team / org entity for a scope.
 * Cap: the endpoint's `limits.cost_usd_total`, which is what the hub reports as `limit_usd`.
 */
import { type APIEntity, type TypeId } from '@sdk';
import { useMemo } from 'react';

import { useLlmEndpoint } from '@src/components/llm-endpoints/use-llm-endpoints';
import { useEntity } from '@src/hooks/entity-hooks';

interface BudgetRow {
  name: string;
  limit_usd: number | null;
  endpoint_id: string | null;
}

/** `scope` is the team / organization typeid for a scope row; omit it for a person's row. */
export function useLiveBudget<R extends BudgetRow>(row: R | undefined, scope?: TypeId): R | undefined {
  const endpoint = useLlmEndpoint(row?.endpoint_id);
  const scopeEntity = useEntity<APIEntity<never>>(scope ?? null).data as { name?: string } | null | undefined;
  const liveName = scope ? scopeEntity?.name : endpoint?.name;
  const liveCap = endpoint ? (endpoint.limits?.cost_usd_total ?? null) : undefined;

  return useMemo(() => {
    if (!row) return row;
    return { ...row, name: liveName || row.name, limit_usd: liveCap === undefined ? row.limit_usd : liveCap };
  }, [row, liveName, liveCap]);
}
