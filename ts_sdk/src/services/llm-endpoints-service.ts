/**
 * Hub `llm_endpoint` actions, typed. Every call is an `ActionInfo` on one
 * endpoint (`/api/v1/graph/llm_endpoint/<id>/<action>`) sent through
 * `dataManager.callAction`, which unwraps the hub envelope and returns `data`.
 *
 * Credentials are write-only: `setCredential` never returns the key, the hub
 * answers with a masked hint, and `testCredential` reports validity only.
 */
import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import type { HttpMethod } from '../models/ApiUrl';
import { LLMEndpoint, type LLMEndpointFilters, type LLMEndpointLimits } from '../entities/llm-endpoint';

const TYPE = 'llm_endpoint';

export interface LLMCredentialSetResult {
  ok: true;
  credential_hint: string;
}

export interface LLMCredentialTestResult {
  valid: boolean;
  status: number;
  models_count: number;
  message?: string;
}

/** The verdict of ``test``: one real, minimal completion sent through the endpoint's chain. */
export interface LLMEndpointTestResult {
  ok: boolean;
  /** The status the call came back with; 0 never happens — the hub always names one. */
  status: number;
  /** The model the probe asked for ('' when it never got that far). */
  model: string;
  latency_ms: number;
  /** Why it failed, in the provider's (or the hub's) own words; '' on success. */
  message: string;
}

export interface LLMEndpointModel {
  id: string;
  root_id: string;
}

export type LLMBreakerState = 'closed' | 'open';

export interface LLMChainRemaining {
  limit: number;
  used: number;
  remaining: number;
  window: string;
  resets_at: number | null;
}

export interface LLMChainHop {
  id: string;
  name: string;
  provider: string | null;
  is_root: boolean;
  has_credential: boolean;
  enabled: boolean;
  breaker: { state: LLMBreakerState; open_until: number | null };
  limits: LLMEndpointLimits;
  remaining: Record<string, LLMChainRemaining>;
  effective_filters: LLMEndpointFilters;
}

export interface LLMChain {
  entry: { id: string; name: string };
  hops: LLMChainHop[];
  /** Ids entry→root, one list per fallback path, in fallback order. */
  paths: string[][];
  missing_sources: string[];
  sticky_root_for_me: string | null;
}

export type LLMUsageGranularity = 'hour' | 'day';
export type LLMUsageBy = 'child' | 'model';

export interface LLMUsageCounters {
  requests: number;
  fallbacks: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  latency_ms_sum: number;
  ttfb_ms_sum: number;
  estimated_requests: number;
  unpriced_requests: number;
  total_tokens: number;
}

export interface LLMUsagePoint extends LLMUsageCounters {
  /** Epoch seconds. */
  bucket_start: number;
  /** The `by` dimension value ("" when un-dimensioned). */
  dim: string;
}

export interface LLMUsageQuery {
  /** Epoch seconds. */
  from: number;
  /** Epoch seconds. */
  to: number;
  granularity: LLMUsageGranularity;
  by?: LLMUsageBy;
}

export interface LLMUsageReport {
  series: LLMUsagePoint[];
  totals: LLMUsageCounters;
  /** Present only when `by` was requested and the caller is an admin. */
  breakdown?: Record<string, LLMUsageCounters>;
  /** Display names for the `by` dimension values (`by=child`: the child
   *  endpoint's name), keyed like `breakdown`. */
  names?: Record<string, string>;
}

/** One hub action call. `id` is null for a bare, type-level action (`catalog`,
 *  `token_plan/me`). Shared with the token plan service — one builder, so the
 *  subpath/method plumbing exists once. */
export function hubAction(name: string, type: string, id: string | null, method: HttpMethod, subpath?: string) {
  const info = new ActionInfo(name, type, id, method);
  if (subpath) info.subpath = subpath;
  return info;
}

function action(name: string, id: string, method: HttpMethod, subpath?: string): ActionInfo {
  return hubAction(name, TYPE, id, method, subpath);
}

export class LlmEndpointsService {
  /**
   * Endpoints the caller may USE without holding a role edge — the hub's `catalog`
   * (entities stamped `authenticated_role`, e.g. the seeded global root). They come
   * without a permission expansion, so `readOnly`/`canDelete` are unknown and the
   * screens treat them as read-only.
   */
  async listShared(): Promise<LLMEndpoint[]> {
    const rows = await dataManager.callAction<undefined, Array<Record<string, unknown>>>(
      new ActionInfo('catalog', TYPE, null, 'GET'),
    );
    return (rows ?? []).map((row) => new LLMEndpoint(row as never));
  }

  setCredential(id: string, key: string): Promise<LLMCredentialSetResult> {
    const info = action('credential', id, 'POST');
    info.bodyParameters = { key };
    return dataManager.callAction<undefined, LLMCredentialSetResult>(info);
  }

  /** Test the stored key, or — when `key` is given — that key WITHOUT storing it. */
  testCredential(id: string, key?: string): Promise<LLMCredentialTestResult> {
    const info = action('credential', id, 'POST', 'test');
    info.bodyParameters = key ? { key } : {};
    return dataManager.callAction<undefined, LLMCredentialTestResult>(info);
  }

  deleteCredential(id: string): Promise<{ ok: true }> {
    return dataManager.callAction<undefined, { ok: true }>(action('credential', id, 'DELETE'));
  }

  /**
   * Does a call through this endpoint succeed? The hub sends ONE minimal completion down the
   * resolved chain, so the answer covers the credential, every hop's filters and budget, the
   * routing and the provider — which is why it works on an allocation, where `testCredential`
   * (a ROOT's key against the provider's model list) refuses outright.
   *
   * A refused or failed call is a VERDICT, not a thrown error: it resolves with `ok: false`.
   */
  testEndpoint(id: string, model?: string): Promise<LLMEndpointTestResult> {
    const info = action('test', id, 'POST');
    info.bodyParameters = model ? { model } : {};
    return dataManager.callAction<undefined, LLMEndpointTestResult>(info);
  }

  listModels(id: string): Promise<LLMEndpointModel[]> {
    return dataManager.callAction<undefined, LLMEndpointModel[]>(action('models', id, 'GET'));
  }

  getChain(id: string): Promise<LLMChain> {
    return dataManager.callAction<undefined, LLMChain>(action('chain', id, 'GET'));
  }

  /**
   * Create an endpoint that draws on `parentId` — the only way a source link comes into being.
   *
   * The parent is the URL, not a field, and that is the whole point: the hub authorizes this
   * against the endpoint being drawn FROM, so delegating a budget requires administering it. The
   * `sources` field it replaces was checked against nothing, which let anyone who could merely
   * spend a pool hang an uncapped sibling off it.
   *
   * `grant_to` is a principal typeid (`user-<id>`, `team-<id>`) that may SPEND the result — the
   * allocation and the grant land in one authorized call. It needs an account that already
   * exists; inviting an address that does not is `inviteMember` on the allocation afterwards.
   */
  allocate(
    parentId: string,
    body: { name: string; limits?: LLMEndpointLimits; filters?: LLMEndpointFilters; grant_to?: string },
  ): Promise<LLMEndpoint> {
    const info = action('allocate', parentId, 'POST');
    info.bodyParameters = { ...body };
    return dataManager.callAction<undefined, LLMEndpoint>(info);
  }

  getUsage(id: string, query: LLMUsageQuery): Promise<LLMUsageReport> {
    const info = action('usage', id, 'GET');
    info.queryParameters = {
      from: query.from,
      to: query.to,
      granularity: query.granularity,
      ...(query.by ? { by: query.by } : {}),
    };
    return dataManager.callAction<undefined, LLMUsageReport>(info);
  }
}

export const llmEndpointsService = new LlmEndpointsService();
