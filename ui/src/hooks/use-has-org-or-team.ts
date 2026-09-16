import { useTokenPlan } from '@src/components/token-plan/use-token-plan';
import { useMembershipAvailability } from '@src/hooks/use-membership-availability';

/**
 * Does this signed-in user belong to any organization or team? The existence
 * gate for the rail's Org & teams button.
 *
 * Organizations and teams are hub-authoritative proxies with no local row to
 * count, and `token_plan/me` is today the only read that covers team AND org in
 * one — the login payload's single `organization` claim cannot express either
 * multiple orgs or a team-only membership.
 *
 * KNOWN COST, accepted deliberately: this is a spend projection answering a
 * membership question, and the rail mounts on every screen, so a signed-in
 * client holds a permanent observer of a ~30-query hub aggregation. That also
 * keeps the shared query ACTIVE, so `useInvalidateTokenPlan` now refetches
 * eagerly on every budget mutation instead of lazily on the next plan surface.
 * The proper fix is a membership-shaped source (a bootstrap flag or a cheap hub
 * `memberships` boolean); it needs a hub change and is tracked separately.
 *
 * The two refetch opt-outs below cut the avoidable half of that: membership does
 * not change on window focus or on reconnect. They bind per observer, so they
 * only hold while the rail is the sole observer — any co-mounted plan surface
 * opts the shared query back in.
 */
export function useHasOrgOrTeam(): boolean {
  const { available } = useMembershipAvailability();
  const { data } = useTokenPlan({ enabled: available, refetchOnWindowFocus: false, refetchOnReconnect: false });
  // `available` is re-checked, not redundant with `enabled`: react-query serves
  // cached data to a disabled observer, and nothing clears the cache on sign-out.
  return available && (data?.scopes ?? []).some((scope) => scope.kind === 'team' || scope.kind === 'org');
}
