/**
 * The LLM endpoints view's pointer: `[<id>[/<tab>]]`.
 *
 * Empty → the list. `<id>` → that endpoint's detail, on `overview` unless a
 * tab is named. Both live in the URL rather than component state (reload lands
 * where you were, drill-down is a navigation), and `foldsPointer` on the
 * registry entry keeps every combination in one tab chip — the credentials
 * view's pattern.
 *
 * No React here: the harness modal, the catalog and the components all import
 * this file, so it must stay a leaf.
 */
import { LLMEndpoint, PageId, TypeId, ViewType, isTypeId } from '@sdk';

import type { NavigationActions } from '@src/navigation/NavigationActions';

export type LlmEndpointTab = 'overview' | 'usage' | 'models';

export const LLM_ENDPOINT_TABS: readonly LlmEndpointTab[] = ['overview', 'usage', 'models'];

const TABS = new Set<string>(LLM_ENDPOINT_TABS);

export function parseLlmEndpointsPointer(pointer?: string | null): { id?: string; tab: LlmEndpointTab } {
  const [id, rawTab] = (pointer ?? '').split('/').filter(Boolean);
  const tab = TABS.has(rawTab) ? (rawTab as LlmEndpointTab) : 'overview';
  // A typeid in the URL (`llm_endpoint-<uuid>`) resolves too — hop ids and
  // `sources` are typeids, so a pasted one should land on the endpoint.
  return { id: id ? endpointIdFromTypeId(id) : undefined, tab };
}

export function llmEndpointsPointer(id?: string, tab?: LlmEndpointTab): string {
  if (!id) return '';
  id = endpointIdFromTypeId(id);
  return tab && tab !== 'overview' ? `${id}/${tab}` : id;
}

/** Navigate to an endpoint's page (page=hub) on `tab` (overview by default);
 *  `id` may be a bare uuid or a typeid. */
export function openLlmEndpoint(navigation: NavigationActions, id: string, tab?: LlmEndpointTab): void {
  navigation.openPage(PageId.HUB, ViewType.LLM_ENDPOINTS, llmEndpointsPointer(id, tab));
}

export const ENDPOINT_TYPE = LLMEndpoint.type;

/** `llm_endpoint-<uuid>` — the typeid form `sources` holds. */
export function endpointTypeId(id: string): string {
  return new TypeId(ENDPOINT_TYPE, id).toString();
}

/** The uuid out of a `llm_endpoint-<uuid>` typeid; the input when it is
 *  already bare (or not a typeid at all). */
export function endpointIdFromTypeId(typeid: string): string {
  return isTypeId(typeid) ? new TypeId(typeid).id : typeid;
}
