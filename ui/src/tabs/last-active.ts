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
  entity: { last_active_at?: number | string | null } | null | undefined,
): void {
  // Epoch-ms to match the base-Entity field (Part 3 §4); the candidate
  // adapter tolerates legacy ISO strings from un-refreshed cache entries.
  if (entity) entity.last_active_at = Date.now();
}
