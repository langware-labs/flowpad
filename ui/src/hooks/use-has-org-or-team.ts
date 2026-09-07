import { useTokenPlan } from '@src/components/token-plan/use-token-plan';
import { useMembershipAvailability } from '@src/hooks/use-membership-availability';

/**
 * Does this signed-in user belong to any organization or team? The existence
 * gate for the rail's Org & teams button.
 *
 * Organizations and teams are hub-authoritative, and `token_plan/me` already
 * resolves exactly this server-side (one scope per principal) on a react-query
 * read other surfaces share. `enabled` is load-bearing: the rail mounts on every
 * screen and the read costs the hub ~30 queries (see `use-token-plan.ts`), so a
 * signed-out or Local-mode client must never trigger it, and membership does not
 * change on window focus, so this observer opts out of the focus refetch.
 */
export function useHasOrgOrTeam(): boolean {
  const { available } = useMembershipAvailability();
  const { data } = useTokenPlan({ enabled: available, refetchOnWindowFocus: false });
  // Not redundant with `enabled`: react-query keeps cached data when a query is
  // disabled, so a sign-out would otherwise leave the button up off stale cache.
  if (!available) return false;
  return (data?.scopes ?? []).some((scope) => scope.kind === 'team' || scope.kind === 'org');
}
