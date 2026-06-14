import { ViewType } from '@src/types/ViewType';
import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * URL-first active-chip key for the unified tab strip.
 *
 * Terminal surfaces (viewType `shell`) resolve their active chip through the
 * terminal controller — terminal chip keys are NOT tabHashes, so the controller
 * maps the URL to its own key. EVERY other (content) dock is active by its own
 * `tabHash`.
 *
 * The content branch must NOT fall back to the controller's MRU terminal key
 * when the dock's Tab row isn't in the strip yet — unmaterialized (loader race)
 * or rootless (bare `/dock/assets` opened from the side rail). That fallback
 * left the agentic-process chip falsely "selected" while a content view was on
 * screen (docs/tab-management.md). When no chip matches, nothing highlights —
 * the correct, URL-first outcome — until the Tab materializes and lights up.
 */
export function activeStripKey(
  currentDock: DockPointer | null | undefined,
  controllerActiveTargetKey: string,
): string {
  if (!currentDock) return '';
  if (currentDock.viewType === ViewType.SHELL) return controllerActiveTargetKey;
  return currentDock.tabHash;
}
