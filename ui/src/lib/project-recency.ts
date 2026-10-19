/**
 * Unified project recency for picker sorts: `last_active_at` (epoch-ms,
 * stamped server-side when the user opens the project or one of its assets)
 * WINS; `modified_at` (ISO, agent-session file mtimes — or the entity's
 * `updated_date`) is the fallback timescale. Mirrors the backend sort in
 * `project_list._recency_ms`.
 *
 * Returns `null` when neither signal is present — callers apply their own
 * null policy (the footer picker treats unknown as "now", others as 0).
 */
export function projectRecencyMs(item: {
  last_active_at?: number | string | null;
  modified_at?: string | Date | null;
}): number | null {
  return toMs(item.last_active_at) ?? toMs(item.modified_at);
}

/** Epoch-ms number passes through; ISO string or `Date` parses; invalid/absent → null. */
function toMs(value: number | string | Date | null | undefined): number | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  if (value) {
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}
