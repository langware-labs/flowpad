import { Tab } from '@sdk';
import { getAllTabsSnapshot, refreshAllTabs } from './all-tabs-store';

/**
 * Stamp recency (`last_active_at`) on the **Tab** entity backing this target,
 * on select. The close-resolver's recency tier (`resolveActive`, tab-model.ts)
 * reads `Tab.last_active_at` — NOT the Shell/AgenticProcess row the loaders
 * already activate — so without this the previously-active tab can never win
 * recency and closing the active tab falls back to `tab_order` instead of
 * popping the most-recently-active tab.
 *
 * Resolves the tab id from the warm all-tabs snapshot (no network) and fires
 * the activate fire-and-forget — loaders must stay fast (the stamp is a
 * resolver seed, never awaited). On a snapshot miss (the tab was materialized
 * this same load and hasn't been adopted into the store yet) it falls back to a
 * one-shot `refreshAllTabs()` (which also warms the store) — still
 * fire-and-forget, off the loader's critical path. No-op if the target
 * genuinely has no tab.
 */
export function stampTabRecencyForTarget(targetType: string, targetId: string): void {
  const matches = (t: { target_type: string | null; target_id: string | null }): boolean =>
    t.target_type === targetType && t.target_id === targetId;

  const cachedId = getAllTabsSnapshot().find(matches)?.id;
  const resolvedId = cachedId !== undefined ? Promise.resolve(cachedId) : refreshAllTabs().then((tabs) => tabs.find(matches)?.id);

  void resolvedId.then((id) => (id ? Tab.activateById(id) : undefined)).catch(() => {});
}
