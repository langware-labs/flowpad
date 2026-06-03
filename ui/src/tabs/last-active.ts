/**
 * Stamp recency on a tab's identity entity when it becomes active.
 *
 * Called from the route loaders (post-navigation — NOT an optimistic click
 * write, so it stays within the URL-first contract) so `resolveActive`'s
 * recency case can restore the LAST-VIEWED tab on a project round-trip (Bug 1),
 * rather than snapping to the first tab.
 *
 * Phase 1: cache-only seed (mutates the cached entity so the self-heal reads it
 * immediately). Backend persistence — so recency survives reload and syncs
 * across clients — is the follow-up (see plan §2b).
 */
export function bumpLastActive(
  entity: { last_active_at?: string | null } | null | undefined,
): void {
  if (entity) entity.last_active_at = new Date().toISOString();
}
