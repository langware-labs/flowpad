/**
 * The LLM endpoints view's pointer: `[<id>[/<tab>]]`.
 *
 * Empty → the list. `<id>` → that endpoint's detail, on `overview` unless a
 * tab is named. Both live in the URL rather than component state (reload lands
 * where you were, drill-down is a navigation), and `foldsPointer` on the
 * registry entry keeps every combination in one tab chip — the credentials
 * view's pattern.
 */

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

export const ENDPOINT_TYPE = 'llm_endpoint';

/** `llm_endpoint-<uuid>` — the typeid form `sources` holds. */
export function endpointTypeId(id: string): string {
  return `${ENDPOINT_TYPE}-${id}`;
}

/** The uuid out of a `llm_endpoint-<uuid>` typeid (or the input, when it is
 *  already bare). Also accepts the hub's `llm_endpoint:<uuid>` spelling. */
export function endpointIdFromTypeId(typeid: string): string {
  const prefix = `${ENDPOINT_TYPE}-`;
  if (typeid.startsWith(prefix)) return typeid.slice(prefix.length);
  const alt = `${ENDPOINT_TYPE}:`;
  if (typeid.startsWith(alt)) return typeid.slice(alt.length);
  return typeid;
}
