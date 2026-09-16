/**
 * Data hooks for the token plan: one read (`token_plan/me`) and a setup mutation
 * that also invalidates the endpoint queries (a setup creates/rebases endpoints
 * the expert page lists).
 *
 * Observers: the screen, the hub-home card, the harness-modal chip — and the
 * rail's Org & teams gate (`use-has-org-or-team.ts`). React-query dedups only
 * observers that are CO-MOUNTED, and the first three are screen-specific and
 * mutually exclusive in practice, so the always-mounted rail is usually the sole
 * observer and therefore the cause of the request. It is also what keeps this
 * query permanently active, which makes `useInvalidateTokenPlan` refetch eagerly
 * rather than on the next mount. See that hook for why it reads this at all.
 */
import { tokenPlanService, type TokenPlan, type TokenPlanScopeKind } from '@sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const TOKEN_PLAN_QUERY_KEY = ['token-plan', 'me'] as const;

export function useTokenPlan(
  options: { enabled?: boolean; refetchOnWindowFocus?: boolean; refetchOnReconnect?: boolean } = {},
) {
  return useQuery<TokenPlan>({
    queryKey: TOKEN_PLAN_QUERY_KEY,
    queryFn: () => tokenPlanService.me(),
    staleTime: 15_000,
    // Budget data, not a live counter: one read costs the hub ~30 queries. No
    // poll — every mutation path invalidates through `useInvalidateTokenPlan`,
    // and a focus refetch covers "I came back after spending". A background
    // interval would re-run that ~30-query read forever on any open hub tab.
    // Both refetch flags are per-OBSERVER: an observer that opts out only
    // suppresses the read while no co-mounted observer has opted in.
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? true,
    refetchOnReconnect: options.refetchOnReconnect ?? true,
    retry: false,
    enabled: options.enabled ?? true,
  });
}

/** Invalidate everything a budget change can move: the plan and the endpoint
 *  screens' queries (`['llm-endpoint', …]` — list, chain, usage). */
export function useInvalidateTokenPlan() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: TOKEN_PLAN_QUERY_KEY }),
      qc.invalidateQueries({ queryKey: ['llm-endpoint'] }),
    ]);
}

export function useSetupScope() {
  const invalidate = useInvalidateTokenPlan();
  return useMutation({
    mutationFn: ({ kind, id }: { kind: Exclude<TokenPlanScopeKind, 'me'>; id: string }) =>
      kind === 'team' ? tokenPlanService.setupTeam(id) : tokenPlanService.setupOrg(id),
    onSuccess: () => invalidate(),
  });
}
