/**
 * The LLM sources view's pointer: `[<worker>]` — the harness in focus.
 *
 * Empty → the first harness. The focus lives in the URL rather than component state (reload
 * lands where you were, and the chip strip is a navigation), and `foldsPointer` on the registry
 * entry keeps every harness in one tab chip — the credentials view's pattern.
 *
 * A worker, not a section: the page shows every source for ONE harness, so that is the only
 * thing the address has to carry. An earlier draft declared a `device|key|endpoint|mapping|
 * defaults` vocabulary across `dock_address.py`, `view-types.ts` and the contract fixture — five
 * members of which the view read one.
 *
 * No React here: the version popover imports this file, so it must stay a leaf (same rule as
 * `llm-endpoints-pointer.ts`).
 */
import { PageId, ViewType } from '@sdk';

import type { NavigationActions } from '@src/navigation/NavigationActions';

/** The worker the pointer selects, or `undefined` for "whichever is first". */
export function parseLlmSourcesPointer(pointer?: string | null): string | undefined {
  return (pointer ?? '').split('/').filter(Boolean)[0] || undefined;
}

export function llmSourcesPointer(worker?: string): string {
  return worker ?? '';
}

/** Navigate to the LLM sources page (page=desk), optionally focused on one harness. */
export function openLlmSources(navigation: NavigationActions, worker?: string): void {
  navigation.openPage(PageId.DESK, ViewType.LLM_SOURCES, llmSourcesPointer(worker));
}
