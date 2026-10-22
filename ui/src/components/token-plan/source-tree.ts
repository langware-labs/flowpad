/**
 * The token sources tree: every LLM endpoint the caller can reach, laid out under the budget it
 * draws from. Parents come from the hub (`LLMEndpoint.parentIds`, the `partof` source edges on a
 * permissions read); a row whose parent is not visible to the caller is a top-level row.
 *
 * Pure — no React — so it is unit-tested on hand-built rows.
 */
import type { LLMEndpoint, TokenPlanScope } from '@sdk';

import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { isCostKey } from '@src/components/llm-endpoints/usage-math';

/** Who pays: the sponsor filter's vocabulary. */
export type Sponsor = 'key' | 'team' | 'org' | 'shared';

export function sponsorOf(endpoint: Pick<LLMEndpoint, 'sponsorKind'>): Sponsor {
  switch (endpoint.sponsorKind) {
    case 'user':
      return 'key';
    case 'team':
      return 'team';
    case 'organization':
      return 'org';
    default:
      return 'shared';
  }
}

/** The seeded system endpoint Flowpad pays for (the hub's `GLOBAL_LLM_ENDPOINT_ID`). */
export const FLOWPAD_ACCOUNT_ID = '7f1c9d2e-0000-4a00-8000-11e0e0e0e0e0';

/** Where a source's money comes from, from the caller's side. */
export type SourceType = 'key' | 'received' | 'unfunded';

export interface SourceRow {
  endpoint: LLMEndpoint;
  type: SourceType;
  /** A received source drawn from the Flowpad account. */
  flowpadAccount: boolean;
}

function owns(e: LLMEndpoint): boolean {
  return (e.expand?.roles ?? []).includes('owner' as never);
}

/**
 * The caller's root token sources -- and nothing else:
 *
 * * `key` -- a root the caller owns, funded by the provider key they stored;
 * * `unfunded` -- a root the caller owns with no key: it cannot pay for anything;
 * * `received` -- a budget given to the caller (their allowance, a share, a pool they run) whose
 *   source is not one of their own: the money is someone else's.
 *
 * Allocations the caller carved out of their own sources are not sources and are left out (the
 * centre lists them under the source they draw from), as are disabled rows and the catalog's
 * shared roots (no permission expansion: the caller holds no role on them).
 */
export function sourceRows(endpoints: readonly LLMEndpoint[]): SourceRow[] {
  const live = endpoints.filter((e) => e.expand?.allowed_actions && e.enabled !== false);
  // A received row whose source is itself on this list is an allocation of that source, not a source.
  const listed = new Set(live.map((e) => e.id));
  const rows: SourceRow[] = [];
  for (const e of live) {
    const parents = e.parentIds;
    if (owns(e) && parents.length === 0) {
      rows.push({ endpoint: e, type: e.hasCredential ? 'key' : 'unfunded', flowpadAccount: false });
    } else if (!owns(e) && !parents.some((id) => listed.has(id))) {
      rows.push({ endpoint: e, type: 'received', flowpadAccount: parents.includes(FLOWPAD_ACCOUNT_ID) });
    }
  }
  const order: Record<SourceType, number> = { received: 0, key: 1, unfunded: 2 };
  return rows.sort(
    (a, b) => order[a.type] - order[b.type] || (a.endpoint.name || '').localeCompare(b.endpoint.name || ''),
  );
}

/** The cost limit a row is judged by: its tightest USD window, or null when it has none. */
export function costLeft(endpoint: Pick<LLMEndpoint, 'ownRemaining'>) {
  const cost = endpoint.ownRemaining.filter((r) => r.limit > 0 && isCostKey(r.key));
  if (!cost.length) return null;
  return cost.reduce((a, b) => (b.remaining < a.remaining ? b : a));
}

/** The budgets drawn directly from `parent`. */
export function childrenOf(parent: LLMEndpoint, endpoints: readonly LLMEndpoint[]): LLMEndpoint[] {
  return endpoints.filter((e) => e.id !== parent.id && e.parentIds.includes(parent.id));
}

/** The caller's token plan scope whose pool is this endpoint, if any (scopes carry typeids). */
export function scopeForEndpoint(scopes: readonly TokenPlanScope[], endpointId: string | null | undefined) {
  if (!endpointId) return undefined;
  return scopes.find((s) => !!s.endpoint_id && endpointIdFromTypeId(s.endpoint_id) === endpointId);
}
