/**
 * The LLM sources view's pointer: `[<section>[/<key>]]`.
 *
 * Empty → the list. `device/<worker>`, `key/<provider>` and `endpoint/<id>` select one source.
 * The selection lives in the URL rather than component state (reload lands where you were,
 * drill-down is a navigation), and `foldsPointer` on the registry entry keeps every combination
 * in one tab chip — the credentials view's pattern.
 *
 * No React here: the version popover and the warnings popover both import this file, so it must
 * stay a leaf (same rule as `llm-endpoints-pointer.ts`).
 */
import { LlmSourcesSection, PageId, ViewType } from '@sdk';

import type { NavigationActions } from '@src/navigation/NavigationActions';

export const LLM_SOURCES_SECTIONS: readonly LlmSourcesSection[] = [
  LlmSourcesSection.Device,
  LlmSourcesSection.Key,
  LlmSourcesSection.Endpoint,
  LlmSourcesSection.Mapping,
  LlmSourcesSection.Defaults,
];

const SECTIONS = new Set<string>(LLM_SOURCES_SECTIONS);

export interface LlmSourcesPointer {
  section?: LlmSourcesSection;
  /** The worker / provider / endpoint id the section selects, when it takes one. */
  key?: string;
}

export function parseLlmSourcesPointer(pointer?: string | null): LlmSourcesPointer {
  const [rawSection, ...rest] = (pointer ?? '').split('/').filter(Boolean);
  if (!SECTIONS.has(rawSection)) return {};
  const section = rawSection as LlmSourcesSection;
  const key = rest.join('/') || undefined;
  return key ? { section, key } : { section };
}

export function llmSourcesPointer(section?: LlmSourcesSection, key?: string): string {
  if (!section) return '';
  return key ? `${section}/${key}` : section;
}

/** Navigate to the LLM sources page (page=desk). */
export function openLlmSources(navigation: NavigationActions, section?: LlmSourcesSection, key?: string): void {
  navigation.openPage(PageId.DESK, ViewType.LLM_SOURCES, llmSourcesPointer(section, key));
}

/** The pointer that selects a given source, so a row and a deep link agree on one spelling. */
export function pointerForSource(source: { kind: string; provider: string; endpoint_typeid: string }): string {
  if (source.kind === LlmSourcesSection.Device) return '';
  if (source.kind === 'api_key') return llmSourcesPointer(LlmSourcesSection.Key, source.provider);
  return llmSourcesPointer(LlmSourcesSection.Endpoint, source.endpoint_typeid);
}
