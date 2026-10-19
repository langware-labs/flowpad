/**
 * The LLM sources view's pointer: `[<worker>]` — the harness in focus.
 *
 * Empty → the first harness. The focus lives in the URL rather than component state (reload
 * lands where you were, and the chip strip is a navigation), and `foldsPointer` on the registry
 * entry keeps every harness in one tab chip — the credentials view's pattern.
 *
 * A worker, or one of two box-wide SECTIONS: `keys` (the API keys stored on this machine) and
 * `endpoints` (the hub endpoints this account can spend). An earlier draft declared a
 * `device|key|endpoint|mapping|defaults` vocabulary of which the view read one member; the two
 * here each have a screen of their own behind them (the key form, the endpoints with what is
 * left on them), reached from the Assistants & keys modal's Details buttons.
 *
 * No React here: the version popover imports this file, so it must stay a leaf (same rule as
 * `llm-endpoints-pointer.ts`).
 */
import { PageId, ViewType } from '@sdk';

import type { NavigationActions } from '@src/navigation/NavigationActions';

/** The box-wide sections the pointer may name instead of a harness. Mirrored in
 *  `dock_address.py` (`LLM_SOURCES` subplaces) and the contract fixture. */
export const LLM_SOURCES_SECTIONS = ['keys', 'endpoints'] as const;
export type LlmSourcesSection = (typeof LLM_SOURCES_SECTIONS)[number];

export function isLlmSourcesSection(pointer: string | undefined): pointer is LlmSourcesSection {
  return (LLM_SOURCES_SECTIONS as readonly string[]).includes(pointer ?? '');
}

/** The worker or section the pointer selects, or `undefined` for "whichever harness is first". */
export function parseLlmSourcesPointer(pointer?: string | null): string | undefined {
  return (pointer ?? '').split('/').filter(Boolean)[0] || undefined;
}

export function llmSourcesPointer(target?: string): string {
  return target ?? '';
}

/** Navigate to the LLM sources page (page=desk), optionally focused on one harness or section. */
export function openLlmSources(navigation: NavigationActions, target?: string): void {
  navigation.openPage(PageId.DESK, ViewType.LLM_SOURCES, llmSourcesPointer(target));
}
