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
 * setting a budget up is `tokenPlanService.setupOrg()` / `setupTeam()`, a separate decision.
 * Writing a budget is a plain `LLMEndpoint` entity update (`limits.cost_usd_total`); handing one
 * out is `llmEndpointsService.allocate()`. No budgets action does any of that.
 */
import { dataManager } from '../APIEntity';
import { hubAction } from './llm-endpoints-service';

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

/** One person's allowance under a team pool. */
export interface MemberBudget {
  /** The person's own endpoint (a typeid) — the thing whose cap is edited. */
  endpoint_id: string;
  name: string;
  email: string | null;
  user_id: string | null;
  limit_usd: number | null;
  spent_usd: number;
  /**
   * True for the hub's own per-user default. Its cap is editable like any other, but deleting it
   * is pointless — the token plan mints it again on that user's next read — so the screen offers
   * no remove on these.
   */
  system_default: boolean;
}

export interface OrgBudgets {
  org: ScopeBudget;
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
}

export const budgetsService = new BudgetsService();
