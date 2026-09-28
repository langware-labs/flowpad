/**
 * "Who's spending" rows: the scope endpoint's today and month reports merged per member.
 *
 * Pure, and out of `MembersTable.tsx` so that file exports only components — a non-component
 * export there breaks React Fast Refresh.
 */
import type { LLMUsageCounters, LLMUsageReport } from '@sdk';

import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { childLabel } from '@src/components/llm-endpoints/usage-math';

export interface MemberRow {
  /** Bare endpoint uuid. */
  id: string;
  name: string;
  today: LLMUsageCounters | null;
  month: LLMUsageCounters | null;
}

/** Merge the two reports into rows, month spend descending. Pure.
 *  `onlyId` is a BARE uuid — callers holding a typeid must normalise first. */
export function memberRows(
  today: LLMUsageReport | undefined,
  month: LLMUsageReport | undefined,
  onlyId?: string,
  lookup?: (id: string) => string | undefined,
): MemberRow[] {
  const dims = new Set<string>([...Object.keys(today?.breakdown ?? {}), ...Object.keys(month?.breakdown ?? {})]);
  const names = { ...(today?.names ?? {}), ...(month?.names ?? {}) };
  const rows: MemberRow[] = [];
  for (const dim of dims) {
    if (dim === '') continue; // usage that entered here directly — not a member
    const id = endpointIdFromTypeId(dim);
    if (onlyId && id !== onlyId) continue;
    rows.push({
      id,
      name: childLabel(dim, names, lookup),
      today: today?.breakdown?.[dim] ?? null,
      month: month?.breakdown?.[dim] ?? null,
    });
  }
  return rows.sort((a, b) => (b.month?.cost_usd ?? 0) - (a.month?.cost_usd ?? 0));
}
