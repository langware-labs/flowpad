/**
 * Data hooks for the token plan: one read (`token_plan/me`) shared by the
 * screen, the hub-home card and the harness-modal chip — react-query dedups
 * them into one request — and a setup mutation that also invalidates the
 * endpoint queries (a setup creates/rebases endpoints the expert page lists).
 */
import { tokenPlanService, type TokenPlan, type TokenPlanScopeKind } from '@sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const TOKEN_PLAN_QUERY_KEY = ['token-plan', 'me'] as const;

export function useTokenPlan(options: { enabled?: boolean } = {}) {
  return useQuery<TokenPlan>({
    queryKey: TOKEN_PLAN_QUERY_KEY,
    queryFn: () => tokenPlanService.me(),
    staleTime: 15_000,
    // Budget data, not a live counter: one read costs the hub ~30 queries and
    // three observers (screen, home card, harness chip) share this one query.
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
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
      kind === 'team' ? tokenPlanService.setupTeam(id) : tokenPlanService.setupOrg(),
    onSuccess: () => invalidate(),
  });
}
