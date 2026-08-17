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
}

function action(name: string, id: string, method: HttpMethod, subpath?: string): ActionInfo {
  const info = new ActionInfo(name, TYPE, id, method);
  if (subpath) info.subpath = subpath;
  return info;
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

  listModels(id: string): Promise<LLMEndpointModel[]> {
    return dataManager.callAction<undefined, LLMEndpointModel[]>(action('models', id, 'GET'));
  }

  getChain(id: string): Promise<LLMChain> {
    return dataManager.callAction<undefined, LLMChain>(action('chain', id, 'GET'));
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
