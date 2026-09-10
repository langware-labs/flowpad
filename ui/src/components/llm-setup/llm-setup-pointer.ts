/**
 * The LLM setup chooser's pointer: there isn't one.
 *
 * The screen asks a single question — "what should issue your LLM calls" — and has no
 * selection to address, so `ViewType.LLM_SETUP` is registered with `PointerRequirement.NONE`
 * in `flow_sdk/core/dock_address.py`. This file exists for the opener alone, so callers reach
 * the screen the same way they reach every other one rather than hand-building `/dock/...`.
 *
 * No React here, for the same reason as `llm-sources-pointer.ts`: non-view callers import the
 * opener, so it must stay a leaf.
 */
import { PageId, ViewType } from '@sdk';

import type { NavigationActions } from '@src/navigation/NavigationActions';

/** Navigate to the LLM setup chooser (page=desk). */
export function openLlmSetup(navigation: NavigationActions): void {
  navigation.openPage(PageId.DESK, ViewType.LLM_SETUP, '');
}
