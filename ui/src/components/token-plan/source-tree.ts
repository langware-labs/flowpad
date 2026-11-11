/**
 * The token sources tree: every LLM endpoint the caller can reach, laid out under the budget it
 * draws from. Parents come from the hub (`LLMEndpoint.parentIds`, the `partof` source edges on a
 * permissions read); a row whose parent is not visible to the caller is a top-level row.
 *
 * Pure — no React — so it is unit-tested on hand-built rows.
 */
import type { LLMChain, LLMChainHop, LLMChainRemaining, LLMEndpoint, TokenPlanScope } from '@sdk';

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

/** What a hop is on the funding path, in the token plan's own words (`TokenPlanHopKind`). */
export type FundingKind = 'me' | 'team' | 'org' | 'global' | 'root' | 'endpoint';

export interface FundingHop {
  id: string;
  kind: FundingKind;
  /** The pool's own name; empty on a hop the hub narrowed. */
  name: string;
  /** The team or organization whose pool this is. */
  scopeName: string | null;
  /** The caller may not read this hop: the hub sent its kind and scope name only. */
  redacted: boolean;
  hop: LLMChainHop;
}

const KIND_OF_SOURCE: Record<string, FundingKind> = { user: 'me', team: 'team', organization: 'org', global: 'global' };

/** The chain's FIRST path (the one the router tries first), entry → root, as the hub sent it. Hops
 *  the hub left out (deeper levels the caller may not read) are simply absent. */
export function fundingPath(chain: LLMChain | null | undefined): FundingHop[] {
  if (!chain) return [];
  const byId = new Map((chain.hops ?? []).map((h) => [h.id, h]));
  const out: FundingHop[] = [];
  for (const id of chain.paths?.[0] ?? []) {
    const hop = byId.get(id);
    if (!hop) continue;
    const kind = KIND_OF_SOURCE[hop.source_kind ?? ''] ?? (hop.is_root ? 'root' : 'endpoint');
    out.push({
      id,
      kind,
      name: hop.name ?? '',
      scopeName: hop.scope_name ?? null,
      redacted: hop.limits === undefined && hop.remaining === undefined,
      hop,
    });
  }
  return out;
}

/** Who pays for the entry: the first hop above it, or null for a root / an unread chain. */
export function fundedBy(path: readonly FundingHop[]): FundingHop | null {
  return path[1] ?? null;
}

/** The name a funding hop is shown by: its scope (team / org) when it has one, else its own name. */
export function funderName(hop: FundingHop | null | undefined): string {
  if (!hop) return '';
  return hop.scopeName || hop.name;
}

/** The hop's tightest USD window, or null when it carries none (or the hub narrowed it). */
export function hopCostLeft(hop: Pick<LLMChainHop, 'remaining'>): (LLMChainRemaining & { key: string }) | null {
  const cost = Object.entries(hop.remaining ?? {})
    .filter(([key, r]) => r.limit > 0 && isCostKey(key))
    .map(([key, r]) => ({ key, ...r }));
  if (!cost.length) return null;
  return cost.reduce((a, b) => (b.remaining < a.remaining ? b : a));
}

/** The least left on any hop of `path` the caller can read: what they can spend right now. */
export function tightestLeft(path: readonly FundingHop[]): number | null {
  const left = path.map((h) => hopCostLeft(h.hop)).filter((r): r is NonNullable<typeof r> => !!r);
  if (!left.length) return null;
  return Math.max(0, Math.min(...left.map((r) => r.remaining)));
}

/** When a window resets: its `HH:MM` in UTC and the whole hours until then; null for `total`. */
export function resetOf(
  r: Pick<LLMChainRemaining, 'window' | 'resets_at'> | null | undefined,
  now: number = Date.now() / 1000,
): { window: string; utc: string | null; inHours: number | null } | null {
  if (!r) return null;
  if (r.resets_at == null) return { window: r.window, utc: null, inHours: null };
  return {
    window: r.window,
    utc: new Date(r.resets_at * 1000).toISOString().slice(11, 16),
    inHours: Math.max(0, Math.ceil((r.resets_at - now) / 3600)),
  };
}
