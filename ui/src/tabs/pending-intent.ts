/**
 * Pending-intent slot — a single consume-once "the user explicitly asked for
 * THIS tab" signal that survives a project switch / strip rebuild.
 *
 * Set by an explicit action (e.g. a footer-chip click) BEFORE navigating; read
 * by `resolveActive` (precedence case 2) so the explicit pick wins over the
 * recency/order default. This is what stops the index-0 self-heal from
 * overriding a cross-project chip click (Bug 2). Module-scoped + per-client; it
 * is never persisted and never read to highlight a tab.
 */

let pendingIntentKey: string | null = null;

/** Record an explicit activation intent (a membership key). Pass null to clear. */
export function setPendingIntent(key: string | null): void {
  pendingIntentKey = key;
}

/** Read the intent without clearing it (resolver input). */
export function peekPendingIntent(): string | null {
  return pendingIntentKey;
}

/** Clear the intent once the resolver reports it was the deciding factor. */
export function consumePendingIntent(): void {
  pendingIntentKey = null;
}
