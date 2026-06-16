/**
 * Loader-side default-tab pick over backend `TabRow`s (the one source). Maps rows
 * to the pure `resolveActive` resolver (`tab-model.ts`) and returns the chosen row.
 * Recency comes from `TabRow.last_active_at` (server-stamped by the `activate`
 * action on select), so there is no per-entity recency seed to maintain.
 */
import { AgenticProcess, type TabRow } from '@sdk';
import { resolveActive } from './tab-model';
import { consumePendingIntent, peekPendingIntent } from './pending-intent';

/** The canonical terminal target key for a row — `shell-<id>` / `agentic_process-<id>`
 *  (the TypeId string), which is also the format a footer-chip click pins as its
 *  pending intent and the format loaders put in their `excludeIds` set. */
export function rowTargetKey(row: TabRow): string {
  return `${row.target_type}-${row.target_id}`;
}

/** Epoch ms of a row's last activation (recency seed), or null. Wire is epoch-ms;
 *  tolerate a legacy ISO string during the transition. */
function rowLastActiveMs(row: TabRow): number | null {
  const raw = row.last_active_at;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/**
 * Pick the best terminal tab to make active from a pre-filtered row list, via the
 * single `resolveActive` precedence (intent → recency → tab_order; `urlActiveKey`
 * is null — loaders run this only when the URL has no concrete target).
 *
 * Eligibility: not disabled, has a target, and none of the row's ids (its target
 * key or bare target id) is in `excludeIds` (one set — process and shell ids are
 * both UUIDs and don't collide). A pending intent that decided the pick is consumed.
 */
export function resolveNextTabRow(rows: TabRow[], excludeIds: Set<string> = new Set()): TabRow | null {
  const eligible = rows.filter((r) => {
    if (r.is_disabled || !r.target_id) return false;
    if (excludeIds.has(rowTargetKey(r)) || excludeIds.has(r.target_id)) return false;
    return true;
  });
  const { activeKey, consumedPendingIntent } = resolveActive({
    candidates: eligible.map((r) => ({ key: rowTargetKey(r), lastActiveAt: rowLastActiveMs(r), tabOrder: r.tab_order })),
    urlActiveKey: null,
    pendingIntentKey: peekPendingIntent(),
  });
  if (consumedPendingIntent) consumePendingIntent();
  if (!activeKey) return null;
  return eligible.find((r) => rowTargetKey(r) === activeKey) ?? null;
}

/** Whether a terminal row is backed by an AgenticProcess (vs a plain shell). */
export function rowIsProcess(row: TabRow): boolean {
  return row.target_type === AgenticProcess.type;
}
