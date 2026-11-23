/**
 * The LLM endpoints view's pointer: `[<id>[/<tab>]]`, or `api[/<id>[/<tab>]]` for the Cloud APIs
 * side of the same screen (a first segment that is an id is an LLM endpoint, so old links hold).
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
import { LLMEndpoint, Layout, PageId, TypeId, ViewType, isTypeId } from '@sdk';

import type { NavigationActions } from '@src/navigation/NavigationActions';

/** `models` is an LLM endpoint's third tab, `prices` an API endpoint's. */
export type LlmEndpointTab = 'overview' | 'usage' | 'models' | 'prices';

/** Which endpoints the screen shows: LLM endpoints, or API endpoints (pictures, video, any cloud API). */
export type EndpointFamilyId = 'llm' | 'api';

const API_SEGMENT = 'api';

const TABS = new Set<string>(['overview', 'usage', 'models', 'prices']);

export function parseLlmEndpointsPointer(pointer?: string | null): { id?: string; tab: LlmEndpointTab } {
  const { id, tab } = parseEndpointsPointer(pointer);
  return { id, tab };
}

/** The pointer with its family: `api/…` is the Cloud APIs side, anything else the LLM side. */
export function parseEndpointsPointer(pointer?: string | null): {
  family: EndpointFamilyId;
  id?: string;
  tab: LlmEndpointTab;
} {
  const segments = (pointer ?? '').split('/').filter(Boolean);
  const family: EndpointFamilyId = segments[0] === API_SEGMENT ? 'api' : 'llm';
  const [id, rawTab] = family === 'api' ? segments.slice(1) : segments;
  const tab = TABS.has(rawTab) ? (rawTab as LlmEndpointTab) : 'overview';
  // A typeid in the URL (`llm_endpoint-<uuid>`) resolves too — hop ids and
  // `sources` are typeids, so a pasted one should land on the endpoint.
  return { family, id: id ? endpointIdFromTypeId(id) : undefined, tab };
}

export function llmEndpointsPointer(id?: string, tab?: LlmEndpointTab, family: EndpointFamilyId = 'llm'): string {
  const prefix = family === 'api' ? API_SEGMENT : '';
  if (!id) return prefix;
  id = endpointIdFromTypeId(id);
  const rest = tab && tab !== 'overview' ? `${id}/${tab}` : id;
  return prefix ? `${prefix}/${rest}` : rest;
}

/** Navigate to an endpoint's page (page=hub) on `tab` (overview by default);
 *  `id` may be a bare uuid or a typeid. */
export function openLlmEndpoint(
  navigation: NavigationActions,
  id: string,
  tab?: LlmEndpointTab,
  family: EndpointFamilyId = 'llm',
): void {
  navigation.openPage(PageId.HUB, ViewType.LLM_ENDPOINTS, llmEndpointsPointer(id, tab, family));
}

/**
 * Where an emailed share invitation should land: this endpoint's own page.
 *
 * The TS twin of `endpoint_share_landing_path` (`flow_sdk/builtin/llm_endpoint.py`), and it lives
 * here for that module's stated reason — this file owns the address grammar, so a hand-written
 * path would keep working while a viewType or page-segment rename went green everywhere else,
 * and the only symptom would be an emailed invite that 404s.
 *
 * Without a `callback_override` the hub falls back to a bare entity URL the app has no route
 * for, and the recipient's one click lands nowhere.
 */
export function endpointShareLandingPath(id: string): string {
  const pointer = encodeURIComponent(endpointIdFromTypeId(id));
  return `/${Layout.DOCK}/${PageId.HUB}/${ViewType.LLM_ENDPOINTS}/${pointer}`;
}

export const ENDPOINT_TYPE = LLMEndpoint.type;

/** `llm_endpoint-<uuid>` — the typeid form `sources` holds. */
export function endpointTypeId(id: string, type: string = ENDPOINT_TYPE): string {
  return new TypeId(type, id).toString();
}

/** The uuid out of a `llm_endpoint-<uuid>` typeid; the input when it is
 *  already bare (or not a typeid at all). */
export function endpointIdFromTypeId(typeid: string): string {
  return isTypeId(typeid) ? new TypeId(typeid).id : typeid;
}
