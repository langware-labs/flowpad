/**
 * "Which budgets are MINE?" — the one answer, used by the Assets tree root, the
 * asset list and the read-only detail view.
 *
 * The source is the box's own funding read (`llm-endpoint` on `compute_node/@local`),
 * not the hub entity query the expert screen uses: `llm_endpoint` has no local rows, so
 * `dataManager` cannot list it on a desktop. What the box returns is already
 * access-scoped by the hub — a person's own allocations plus anything shared with them,
 * and nothing about the pools they merely draw THROUGH.
 *
 * The narrowing on top of that is the whole point of this file: the hub lists a row for
 * everything the caller may TOUCH, which for an owner includes the organization's pool, its
 * teams' pools, and every allowance they minted for somebody else. None of those is their
 * budget.
 *
 * So a row is kept when the hub says it is THIS person's: `is_mine`, which the hub answers from
 * the `partof` edge between the allowance and the holder, in the same permission expansion the
 * listing already asks for. The box compares nothing and joins nothing — it reads the answer.
 *
 * A group's pot is excluded because it is `partof` the org or the team and not a person, and the
 * shared catalog root because a catalog row carries no expansion to answer with.
 */
import { TypeId, dataContext, llmSourcesService, type LLMEndpointOffer, type LLMFundingStatus } from '@sdk';

import { useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { DockPointer } from '@src/navigation/DockPointer';

import { ENDPOINT_TYPE, endpointIdFromTypeId } from './llm-endpoints-pointer';

/**
 * True when the hub says this endpoint is the signed-in person's to SPEND.
 *
 * One question, one answer, and deliberately no local reasoning: `is_mine` is decided on the hub,
 * which is the only place that holds both the caller and the row's `partof` edge to its holder.
 *
 * `null` is UNANSWERED, never "no" — a catalog row (asked for without an expansion on purpose) or
 * a hub too old to say. It is excluded here because an unanswered row is not provably anyone's,
 * which is also what keeps the shared company root out of everybody's personal list.
 *
 * `can_administer` is NOT consulted, and the difference matters: it used to stand in for this
 * question as "if you cannot change it, it must be yours", which is right for a member and exactly
 * wrong for an admin — they CAN change their own allowance, so their own budget fell out of their
 * own list.
 */
export function isAllocatedToUser(offer: LLMEndpointOffer): boolean {
  return offer.is_mine === true;
}

/** The endpoints allocated to the signed-in person, by name. Pure — the unit of test. */
export function myEndpoints(status: LLMFundingStatus | null | undefined): LLMEndpointOffer[] {
  return (status?.available ?? [])
    .filter((offer) => isAllocatedToUser(offer))
    .slice()
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

/** Imperative form for the tree adapter, which lists children outside React. */
export async function fetchMyEndpoints(): Promise<LLMEndpointOffer[]> {
  try {
    // The project is part of this asset's cache key, so omitting it here would open a SECOND
    // entry and a second backend round-trip for the same `available` list the screen and the
    // footer chip already hold — undoing the sharing this function's own comment promises.
    // `available` itself is project-independent; the key just has to match.
    // One read now: the status record was only ever fetched here to supply the hub user id for
    // the local comparison, and the hub answers `is_mine` itself.
    return myEndpoints(await llmSourcesService.status(dataContext.project?.id));
  } catch {
    // A box that cannot answer has no endpoints to show; the row simply stays empty
    // rather than erroring the whole Assets tree.
    return [];
  }
}

/** Through the SAME cached read the LLM-sources screen uses, so the count badge, the
 *  list and the detail cost one request between them — and can never disagree. */
export function useMyEndpoints(): { endpoints: LLMEndpointOffer[]; isLoading: boolean } {
  const { status, isLoading } = useLlmSources();
  return { endpoints: myEndpoints(status), isLoading };
}

/** One endpoint by bare uuid or typeid — the URL carries the typeid, the row's own id is
 *  bare, and comparing the two forms directly silently never matches. */
export function useMyEndpoint(idOrTypeId: string | null | undefined): {
  endpoint: LLMEndpointOffer | null;
  isLoading: boolean;
} {
  const { endpoints, isLoading } = useMyEndpoints();
  const id = idOrTypeId ? endpointIdFromTypeId(idOrTypeId) : null;
  return { endpoint: id ? (endpoints.find((e) => e.id === id) ?? null) : null, isLoading };
}

/**
 * Where an endpoint OPENS: its read-only page inside the Assets browser.
 *
 * One builder for the tree row, the list row and any deep link, so the three cannot
 * disagree about the URL grammar. Deliberately NOT `openLlmEndpoint` — that one leaves for
 * the hub's administration screen, which is a different question and a different page.
 */
export function endpointAssetPointer(idOrTypeId: string): DockPointer {
  const typeId = new TypeId(ENDPOINT_TYPE, endpointIdFromTypeId(idOrTypeId));
  return DockPointer.forAssetEditorByTypeId(ENDPOINT_TYPE, typeId);
}
