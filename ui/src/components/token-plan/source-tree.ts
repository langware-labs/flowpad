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
export type SponsorFilter = 'all' | Exclude<Sponsor, 'shared'>;

export interface SourceRow {
  endpoint: LLMEndpoint;
  depth: number;
  hasChildren: boolean;
  /** Shown only as context for a filtered-in descendant. */
  dimmed: boolean;
}

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

/**
 * Depth-first rows. Siblings: budgets with children first, then by name. An endpoint with several
 * parents (a fallback chain) hangs under its FIRST visible one — it appears once.
 */
export function buildSourceTree(endpoints: readonly LLMEndpoint[], filter: SponsorFilter = 'all'): SourceRow[] {
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const children = new Map<string, LLMEndpoint[]>();
  const roots: LLMEndpoint[] = [];
  for (const e of endpoints) {
    const parent = e.parentIds.find((id) => byId.has(id) && id !== e.id);
    if (!parent) roots.push(e);
    else if (children.has(parent)) children.get(parent)!.push(e);
    else children.set(parent, [e]);
  }
  const order = (list: LLMEndpoint[]) =>
    [...list].sort(
      (a, b) => Number(!children.has(a.id)) - Number(!children.has(b.id)) || (a.name || '').localeCompare(b.name || ''),
    );
  const matches = (e: LLMEndpoint) => filter === 'all' || sponsorOf(e) === filter;

  const out: SourceRow[] = [];
  const seen = new Set<string>();
  // Returns whether anything in this subtree matched, so a non-matching ancestor is kept dimmed.
  const walk = (e: LLMEndpoint, depth: number): boolean => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    const at = out.length;
    out.push({ endpoint: e, depth, hasChildren: children.has(e.id), dimmed: false });
    let below = false;
    for (const c of order(children.get(e.id) ?? [])) below = walk(c, depth + 1) || below;
    const self = matches(e);
    if (!self && !below) out.splice(at, out.length - at);
    else out[at].dimmed = !self;
    return self || below;
  };
  for (const r of order(roots)) walk(r, 0);
  return out;
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
