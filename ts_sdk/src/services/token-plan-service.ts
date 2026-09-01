/**
 * The hub's Token Plan — the "me / my team / my org" budget layer composed on
 * top of `llm_endpoint` chains. One read (`me`) answers every scope the caller
 * belongs to; the two setups create a team's / the org's scope endpoint and are
 * admin-only on the hub. Limits themselves are set with a plain `LLMEndpoint`
 * entity update (`limits`, `member_default_limits`) — no plan action needed.
 *
 * Wire: `/api/v1/graph/token_plan/me`, `/api/v1/graph/token_plan/team/<id>/setup`,
 * `/api/v1/graph/token_plan/org/setup` (`ApiUrl` always mounts under the graph
 * prefix, which is where the hub serves its bare actions).
 */
import { dataManager } from '../APIEntity';
import type { ActionInfo } from '../models/ActionInfo';
import type { HttpMethod } from '../models/ApiUrl';
import { hubAction, type LLMUsageCounters } from './llm-endpoints-service';

const TYPE = 'token_plan';

export type TokenPlanScopeKind = 'me' | 'team' | 'org';
/** What a hop on a path is, exactly as the hub's `HopKind` literal emits it:
 *  the caller's own default, a team pool, an org pool, the seeded global root,
 *  some other root, or an ordinary chain endpoint in between. */
export type TokenPlanHopKind = TokenPlanScopeKind | 'global' | 'root' | 'endpoint';

/** One configured window of a limit, as the hub already computed it. */
export interface TokenPlanRemaining {
  /** The limit key (`cost_usd_per_day`, `tokens_per_month`, `requests_per_minute`, …). */
  key: string;
  used: number;
  limit: number;
  remaining: number;
  /** Epoch seconds; null for `total` windows. */
  resets_at: number | null;
  /** `day` | `week` | `month` | `total` | `minute`. */
  window: string;
}

export interface TokenPlanHop {
  endpoint_id: string;
  name: string;
  kind: TokenPlanHopKind;
}

export interface TokenPlanSeriesPoint {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  cost_usd: number;
  total_tokens: number;
  requests: number;
}

export interface TokenPlanTotals {
  today: LLMUsageCounters;
  week: LLMUsageCounters;
  month: LLMUsageCounters;
  all: LLMUsageCounters;
}

export interface TokenPlanScope {
  kind: TokenPlanScopeKind;
  /** The principal's id (user / team / org). */
  id: string;
  name: string;
  /** The scope's endpoint; null when a team/org has no budget endpoint yet. */
  endpoint_id: string | null;
  can_configure: boolean;
  /** This scope's spend path, nearest first (me → team → org → root). */
  path: TokenPlanHop[];
  /** The tightest window along the caller's path; null when nothing caps it. */
  headline: TokenPlanRemaining | null;
  /** This scope endpoint's own configured windows. */
  remaining: TokenPlanRemaining[];
  totals: TokenPlanTotals;
  /** Last 30 days, daily. */
  series: TokenPlanSeriesPoint[];
}

export interface TokenPlan {
  /** Epoch seconds. */
  as_of: number;
  scopes: TokenPlanScope[];
}

export interface TokenPlanSetupResult {
  /** The scope endpoint's typeid. */
  endpoint_id: string;
  /** False when the scope already had its endpoint (the call is idempotent). */
  created: boolean;
  /** How many member defaults this call re-sourced under the pool. */
  rebased: number;
}

function action(name: string, method: HttpMethod, subpath?: string): ActionInfo {
  return hubAction(name, TYPE, null, method, subpath);
}

export class TokenPlanService {
  me(): Promise<TokenPlan> {
    return dataManager.callAction<undefined, TokenPlan>(action('me', 'GET'));
  }

  /** Ensure the team's scope endpoint exists (team admin). */
  setupTeam(teamId: string): Promise<TokenPlanSetupResult> {
    return dataManager.callAction<undefined, TokenPlanSetupResult>(action('team', 'POST', `${teamId}/setup`));
  }

  /** Ensure the org's scope endpoint exists (org admin). */
  setupOrg(): Promise<TokenPlanSetupResult> {
    return dataManager.callAction<undefined, TokenPlanSetupResult>(action('org', 'POST', 'setup'));
  }
}

export const tokenPlanService = new TokenPlanService();
