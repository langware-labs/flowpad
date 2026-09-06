/**
 * The hub's `standing` read — what a plain MEMBER may know about an organization they were
 * invited to: its name, their own role on it, and the teams inside it they themselves belong to.
 *
 * The counterpart of `budgetsService.orgBudgets`, which is the ADMIN view of the same screen and
 * refuses everyone below admin (401). Someone who has just accepted an invitation is exactly that
 * everyone, so People & teams used to answer them with a bare "only an admin can see its budgets"
 * — a sentence about a permission, where what they wanted was the name of the thing they joined.
 *
 * Wire: `GET /api/v1/graph/organization/<id>/standing` — an action ON the organization, so the
 * entity in the path is the one the hub's authorizer resolves the caller's role against. It sits
 * on `reader` in the hub policy, which every higher role extends, so an admin may call it too; the
 * admin screens simply have the richer read.
 *
 * Nothing about money travels on it — no pool, no cap, no spend — which is what lets it sit below
 * `budgets` in the first place. Nor anybody else's membership: the roster stays behind `members`.
 */
import { dataManager } from '../APIEntity';
import { hubAction } from './llm-endpoints-service';

/** One team inside the organization that the caller belongs to. */
export interface TeamStanding {
  id: string;
  name: string;
  /** The caller's highest role on that team. A team they hold no role on is not in the list. */
  role: string;
}

/** The caller's own view of an organization. */
export interface OrgStanding {
  id: string;
  name: string;
  /** The caller's highest role on the organization; null when they reach it only through a team. */
  role: string | null;
  teams: TeamStanding[];
}

export class StandingService {
  /** The organization's name, the caller's role on it, and the teams inside it they are in. */
  orgStanding(orgId: string): Promise<OrgStanding> {
    return dataManager.callAction<undefined, OrgStanding>(hubAction('standing', 'organization', orgId, 'GET'));
  }
}

export const standingService = new StandingService();
