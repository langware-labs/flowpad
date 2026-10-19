/**
 * Data hooks for the budgets section: two reads and the writes that invalidate them.
 *
 * The reads are split the way the hub splits them — the org call is bounded by the number of teams
 * and runs when the page opens; the team call carries the per-person fan-out and runs only for the
 * team actually selected (`enabled`). That is what keeps opening the page cheap in an organization
 * with fifty teams.
 *
 * No polling. This is budget data, not a live counter — the same reasoning `use-token-plan.ts`
 * records — so every mutation invalidates explicitly and a focus refetch covers "I came back after
 * someone spent something".
 */
import {
  TypeId,
  budgetsService,
  dataManager,
  type APIEntity,
  type MemberBudget,
  type OrgBudgets,
  type TeamBudgets,
} from '@sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useInvalidateTokenPlan } from '@src/components/token-plan/use-token-plan';

import { addPeopleToTeam, removeAllowance, setLifetimeCap, type PersonDraft } from './add-people';

export const BUDGETS_KEY = ['budgets'] as const;

export const orgBudgetsKey = (orgId: string) => [...BUDGETS_KEY, 'org', orgId] as const;
export const teamBudgetsKey = (teamId: string) => [...BUDGETS_KEY, 'team', teamId] as const;

export function useOrgBudgets(orgId: string | null | undefined) {
  return useQuery<OrgBudgets>({
    queryKey: orgBudgetsKey(orgId ?? ''),
    queryFn: () => budgetsService.orgBudgets(orgId as string),
    enabled: !!orgId,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    // A non-admin gets a flat refusal from the hub; retrying it just repeats the 401.
    retry: false,
  });
}

export function useTeamBudgets(teamId: string | null | undefined) {
  return useQuery<TeamBudgets>({
    queryKey: teamBudgetsKey(teamId ?? ''),
    queryFn: () => budgetsService.teamBudgets(teamId as string),
    enabled: !!teamId,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/**
 * Everything a money change can move: both budget reads and the token plan (a person's own
 * "what's left" chip is the same endpoint seen from the other side).
 */
export function useInvalidateBudgets() {
  const qc = useQueryClient();
  const invalidatePlan = useInvalidateTokenPlan();
  return () => Promise.all([qc.invalidateQueries({ queryKey: BUDGETS_KEY }), invalidatePlan()]);
}

/**
 * Set one pool's or one person's lifetime cap. `null` = uncapped.
 *
 * The invalidation is deliberately NOT awaited. React-query settles a mutation only after its
 * `onSuccess` promise resolves, and `invalidate()` resolves only once every refetch it triggers
 * has come back — the two budget reads, `token_plan/me` (~30 hub queries) and every mounted
 * `['llm-endpoint', …]` query. One slow or paused refetch among those therefore pinned
 * `isPending` true indefinitely, and the money boxes read that flag: the whole table went
 * not-allowed after a save and only came back on remount or reload. The write itself is already
 * done at this point; the refreshed numbers can land whenever they land.
 */
export function useSetLifetimeCap() {
  const invalidate = useInvalidateBudgets();
  return useMutation({
    mutationFn: ({ endpointId, usd }: { endpointId: string; usd: number | null }) => setLifetimeCap(endpointId, usd),
    onSuccess: () => {
      void invalidate();
    },
  });
}

/** Make the org the paying entity on its own key; the caller sets the key afterward with
 *  `llmEndpointsService.setCredential` on the returned `endpoint_id`. */
export function useSetPayingProvider() {
  const invalidate = useInvalidateBudgets();
  return useMutation({
    mutationFn: ({ orgId, provider, baseUrl }: { orgId: string; provider: string; baseUrl?: string }) =>
      budgetsService.setPayingProvider(orgId, { provider, base_url: baseUrl }),
    onSuccess: () => invalidate(),
  });
}

export function useRemoveAllowance() {
  const invalidate = useInvalidateBudgets();
  return useMutation({
    mutationFn: ({ endpointId }: { endpointId: string }) => removeAllowance(endpointId),
    onSuccess: () => invalidate(),
  });
}

/**
 * Take a person off the TEAM -- the members DELETE, the same call the org detail panel makes.
 *
 * This is what "remove" means on a person's budget row. Deleting their allowance instead would be
 * undone on their next read (the hub mints a default for anyone still on the team); removing the
 * membership is the act, and the hub's own `member_removed` listener drops the allowance with it.
 */
export function useRemoveTeamMember() {
  const invalidate = useInvalidateBudgets();
  return useMutation({
    mutationFn: async ({ teamId, userId }: { teamId: string; userId: string }) => {
      const team = await dataManager.getByTypeId<APIEntity<never>>(new TypeId('team', teamId));
      // A team that cannot be resolved is a failed mutation, not a silent no-op: the row would
      // stay on screen with its budget intact and nothing would say why.
      if (!team) throw new Error(`team ${teamId} not found`);
      await team.removeMember(userId);
    },
    onSuccess: () => invalidate(),
  });
}

/** Add or re-budget people on a team pool. Resolves with per-address outcomes; it does not throw
 *  for a row that failed, because the other rows still landed. */
export function useAddPeople() {
  const invalidate = useInvalidateBudgets();
  return useMutation({
    mutationFn: ({
      poolId,
      teamId,
      drafts,
      existing,
    }: {
      poolId: string;
      teamId: string;
      drafts: readonly PersonDraft[];
      existing: readonly MemberBudget[];
    }) => addPeopleToTeam(poolId, teamId, drafts, existing),
    onSuccess: () => invalidate(),
  });
}
