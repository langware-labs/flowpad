import { DockPointer } from '@src/navigation/DockPointer';
import { applyAllTabs } from './all-tabs-store';
import { setupTab } from './tab-lifecycle';

/**
 * The ONE tab-writer composition: materialize a dock's Tab row (get-or-create
 * via `setupTab`) and adopt the returned GLOBAL list into the all-tabs store.
 * Callers: the route loaders (the primary writer) and `VibeWorkspace`'s
 * display-tab ensure (the sanctioned mount-time fallback for rows the loader
 * can't cover — deep-linked child URLs, rows lost to the orphan reap). Keeping
 * both writers on this helper means the adopt/error semantics can't drift.
 *
 * Lives in its own module (not tab-lifecycle) because `all-tabs-store` imports
 * `tab-lifecycle` — folding this in would create an import cycle.
 */
export async function setupTabAndAdopt(
  dock: DockPointer,
  options?: Parameters<typeof setupTab>[1],
): Promise<void> {
  const onMaterialized = options?.onMaterialized;
  let adoptedMaterializedTabs = false;
  const result = await setupTab(dock, {
    ...options,
    onMaterialized: (tabs) => {
      adoptedMaterializedTabs = true;
      onMaterialized?.(tabs);
      applyAllTabs(tabs);
    },
  });
  if (!adoptedMaterializedTabs && result.tabs && result.tabs.length > 0) {
    applyAllTabs(result.tabs);
  }
}
