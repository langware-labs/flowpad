/**
 * Loader-side default-tab pick over backend `Tab`s (the one source). Maps tabs
 * to the pure `resolveActive` resolver (`tab-model.ts`) and returns the chosen tab.
 * Recency comes from `Tab.last_active_at` (server-stamped by the `activate`
 * action on select), so there is no per-entity recency seed to maintain.
 */
import { AgenticProcess, Tab } from '@sdk';
import { resolveActive } from './tab-model';
import { consumePendingIntent, peekPendingIntent } from './pending-intent';

/** The canonical terminal target key for a tab — `shell-<id>` / `agentic_process-<id>`
 *  (the TypeId string), which is also the format a footer-chip click pins as its
 *  pending intent and the format loaders put in their `excludeIds` set. */
export function tabTargetKey(tab: Tab): string {
  return `${tab.target_type}-${tab.target_id}`;
}

/** Whether a tab is in `projectId`'s scope — its own project, or a projectless
 *  tab (`project_id == null`), which belongs to every project (the backend
 *  `filter_for_project` rule). */
export function tabInProject(tab: Tab, projectId: string | null): boolean {
  return tab.project_id === projectId || tab.project_id == null;
}

/** Epoch ms of a tab's last activation (recency seed), or null. Wire is epoch-ms;
 *  tolerate a legacy ISO string during the transition. */
function tabLastActiveMs(tab: Tab): number | null {
  const raw = tab.last_active_at;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** Pick the best tab from one candidate list via the single `resolveActive`
 *  precedence (intent → recency → tab_order; `urlActiveKey` null — we run this
 *  only when the URL has no concrete target). A pending intent that decided the
 *  pick is consumed; a pass that picks nothing consumes nothing. */
function pickActiveTab(tabs: Tab[], excludeIds: Set<string>): Tab | null {
  const eligible = tabs.filter((t) => {
    if (t.is_disabled || !t.target_id) return false;
    if (excludeIds.has(tabTargetKey(t)) || excludeIds.has(t.target_id)) return false;
    return true;
  });
  const { activeKey, consumedPendingIntent } = resolveActive({
    candidates: eligible.map((t) => ({ key: tabTargetKey(t), lastActiveAt: tabLastActiveMs(t), tabOrder: t.tab_order })),
    urlActiveKey: null,
    pendingIntentKey: peekPendingIntent(),
  });
  if (consumedPendingIntent) consumePendingIntent();
  if (!activeKey) return null;
  return eligible.find((t) => tabTargetKey(t) === activeKey) ?? null;
}

/**
 * Pick the best terminal tab to make active.
 *
 * When `preferProjectId` is given, prefer a tab in that project (+ projectless
 * tabs, which belong to every project) so closing a tab keeps you inside your
 * project while it still has tabs; only when that project is empty does the pick
 * skip to the next tab anywhere. Omit `preferProjectId` (or pass an already-scoped
 * `tabs`) for a plain global pick. `null` means no tab is left to make active.
 *
 * Eligibility: not disabled, has a target, and none of the tab's ids (its target
 * key or bare target id) is in `excludeIds` (one set — process and shell ids are
 * both UUIDs and don't collide).
 */
export function resolveNextTab(
  tabs: Tab[],
  excludeIds: Set<string> = new Set(),
  preferProjectId?: string | null,
): Tab | null {
  if (preferProjectId !== undefined) {
    const scoped = tabs.filter((t) => tabInProject(t, preferProjectId));
    const inProject = pickActiveTab(scoped, excludeIds);
    if (inProject) return inProject;
  }
  return pickActiveTab(tabs, excludeIds);
}

/** Whether a terminal tab is backed by an AgenticProcess (vs a plain shell). */
export function tabIsProcess(tab: Tab): boolean {
  return tab.target_type === AgenticProcess.type;
}

// Backward-compat aliases for migration
export const rowTargetKey = tabTargetKey;
export const tabRowInProject = tabInProject;
export const resolveNextTabRow = resolveNextTab;
export const rowIsProcess = tabIsProcess;
