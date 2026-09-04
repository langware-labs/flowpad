/**
 * The hub's `budgets` reads — the administration view of the money: who in an organization may
 * spend how much, and how much is left.
 *
 * Two calls, not one, and the split is deliberate. The screen is master–detail: the tree shows
 * every team, but only ONE team's roster at a time, and a person costs a spend read each. So the
 * org call is bounded by the number of TEAMS, and the per-person fan-out is paid only for the team
 * the owner actually opened.
 *
 * Wire (actions on the principal itself, per the hub's `{type}/{id}/{action}` grammar — which is
 * also what puts each call on the right authorization target, since the entity in the path IS the
 * one the admin check asks about):
 *   `GET /api/v1/graph/organization/<id>/budgets`
 *   `GET /api/v1/graph/team/<id>/budgets`
 *
 * These are READS. A scope with no pool answers `endpoint_id: null` rather than creating one —
 * setting a budget up is `tokenPlanService.setupOrg(orgId)` / `setupTeam(teamId)`, a separate decision.
 * Writing a budget is a plain `LLMEndpoint` entity update (`limits.cost_usd_total`); handing one
 * out is `llmEndpointsService.allocate()`. No budgets action does any of that.
 */
import { dataManager } from '../APIEntity';
import { hubAction } from './llm-endpoints-service';
import type { TokenPlanSetupResult } from './token-plan-service';

/** One principal's pool, as the budgets screen reads it. */
export interface ScopeBudget {
  /** The principal's id (organization or team) — not the endpoint's. */
  id: string;
  name: string;
  /** The scope's pool endpoint (a typeid); null when it has no budget yet. */
  endpoint_id: string | null;
  /** The pool's lifetime cap (`limits.cost_usd_total`); null = uncapped. */
  limit_usd: number | null;
  spent_usd: number;
  /** Lifetime tokens billed against this pool, off the same report as `spent_usd` — the two
   *  numbers can never disagree with each other. */
  spent_tokens: number;
  /**
   * Sum of the CHILDREN's caps, and `null` where the call did not read them — the org view totals
   * its teams, the team view totals its people, and a team row inside the ORG view leaves it null
   * rather than fanning out over every person for a number that screen does not show.
   *
   * It may legitimately exceed `limit_usd`: a pool is allowed to promise more than it holds, and
   * the excess is caught when the money is spent, not when it is promised.
   */
  allocated_usd: number | null;
}

/**
 * The organization's own row — the one place a pool may hold its OWN provider credential instead
 * of drawing on another endpoint. A team's and a person's pool are always chains, so these three
 * fields exist only here rather than on the shared `ScopeBudget` every row uses: on a chain they
 * would forever read `false` / `null` / `''`, sent and never looked at.
 */
export interface OrgScopeBudget extends ScopeBudget {
  is_root: boolean;
  /** `'openrouter' | 'anthropic' | 'openai'` when `is_root`; `null` otherwise. */
  provider: string | null;
  /** `****last4` when a root has a stored key, `''` otherwise. Never the key itself. */
  credential_hint: string;
}

/** One person's allowance under a team pool. */
export interface MemberBudget {
  /** The person's own endpoint (a typeid) — the thing whose cap is edited. */
  endpoint_id: string;
  name: string;
  email: string | null;
  user_id: string | null;
  limit_usd: number | null;
  spent_usd: number;
  spent_tokens: number;
  /**
   * True for the hub's own per-user default. Its cap is editable like any other, but deleting it
   * is pointless — the token plan mints it again on that user's next read — so the screen offers
   * no remove on these.
   */
  system_default: boolean;
}

export interface OrgBudgets {
  org: OrgScopeBudget;
  teams: ScopeBudget[];
}

export interface TeamBudgets {
  team: ScopeBudget;
  members: MemberBudget[];
}

export class BudgetsService {
  /** The organization's pool and one row per team in it. Admin on the org. */
  orgBudgets(orgId: string): Promise<OrgBudgets> {
    return dataManager.callAction<undefined, OrgBudgets>(hubAction('budgets', 'organization', orgId, 'GET'));
  }

  /** One team's pool and one row per person drawing on it. Admin on the team. */
  teamBudgets(teamId: string): Promise<TeamBudgets> {
    return dataManager.callAction<undefined, TeamBudgets>(hubAction('budgets', 'team', teamId, 'GET'));
  }

  /**
   * Make the organization the paying entity on its OWN provider key, instead of an allowance
   * drawn from Flowpad's shared global root. Creates the org's default as a ROOT with no sources;
   * the key itself is set afterward through `llmEndpointsService.setCredential` on the returned
   * `endpoint_id` — this call never carries one. Idempotent on an existing root; refuses (409,
   * surfaced as a thrown error) if the org already draws from a shared pool, since converting a
   * chain into a root in place is not offered.
   */
  setPayingProvider(orgId: string, body: { provider: string; base_url?: string }): Promise<TokenPlanSetupResult> {
    const info = hubAction('set-paying-provider', 'organization', orgId, 'POST');
    info.bodyParameters = { provider: body.provider, base_url: body.base_url ?? '' };
    return dataManager.callAction<undefined, TokenPlanSetupResult>(info);
  }
}

export const budgetsService = new BudgetsService();
