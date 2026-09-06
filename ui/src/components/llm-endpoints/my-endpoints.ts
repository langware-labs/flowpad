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
 * So a row is kept when it is STAMPED with this person (`principal_typeid === user-<me>`, which
 * `hub_user_typeid` supplies — the local user id is a different id entirely and would match
 * nothing), or when it is untagged and they may only SPEND it. See `isAllocatedToUser`: the
 * second half is not a refinement, it is the half that makes "add a person to this budget" work
 * at all, because that flow stamps no principal on what it creates.
 *
 * A group's pot is excluded by the first rule — its principal names the org or the team, not a
 * person — and the shared catalog root by the second, since nobody holds a role on it.
 */
import { TypeId, dataContext, llmSourcesService, type LLMEndpointOffer, type LLMFundingStatus } from '@sdk';

import { useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { DockPointer } from '@src/navigation/DockPointer';

import { ENDPOINT_TYPE, endpointIdFromTypeId } from './llm-endpoints-pointer';

/**
 * True when this endpoint is the signed-in person's to SPEND, by either of the two ways a budget
 * becomes somebody's.
 *
 * 1. **It is stamped with them.** A wallet the hub mints for a person carries
 *    `principal_typeid: user-<them>`.
 * 2. **It was handed to them.** `allocate` — the "add people to this budget" flow — stamps NO
 *    principal at all; the beneficiary exists only as a `reader` grant. So an untagged row is
 *    theirs exactly when they may not change it: a reader spends, an administrator manages.
 *
 * The second rule is what the first version of this file got wrong. Matching on the stamp alone
 * hid every hand-allocated budget from the person it was made for — their Assets tree showed no
 * LLM Endpoints row at all — while the same rows correctly stayed hidden for the admin who minted
 * them. The distinction was never the stamp; it was the role, and the hub already knew it.
 *
 * `can_administer: null` (not held, or an older backend) is NOT "it was given to me": the catalog's
 * shared root reaches every signed-in user, and reading it as a gift would put the company pool in
 * everybody's personal list.
 */
export function isAllocatedToUser(offer: LLMEndpointOffer, hubUserTypeid: string | null | undefined): boolean {
  const me = (hubUserTypeid ?? '').trim().toLowerCase();
  if (!me) return false; // signed out: nothing is provably yours
  // Both spellings of a typeid reach the client (`user-<id>` and `user:<id>`), and only the
  // id half is the identity — comparing the raw strings would miss on the separator alone.
  const idOf = (typeid: string) => typeid.trim().toLowerCase().replace(':', '-');
  const principal = idOf(offer.principal_typeid ?? '');
  if (principal) return principal === idOf(me);
  return offer.can_administer === false;
}

/** The endpoints allocated to the signed-in person, by name. Pure — the unit of test. */
export function myEndpoints(status: LLMFundingStatus | null | undefined): LLMEndpointOffer[] {
  return (status?.available ?? [])
    .filter((offer) => isAllocatedToUser(offer, status?.hub_user_typeid))
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
