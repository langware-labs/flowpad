/**
 * Which sources the LLM Sources screen actually SHOWS for one harness.
 *
 * The box reports every endpoint the hub let this person touch, and for an owner or an admin
 * that is far more than their own budget: the organization's pool, each team's pool, and every
 * allowance they minted for somebody else. All of it is legitimately visible — none of it is
 * theirs to spend — and listing it here turns "where do my tokens come from" into an
 * administration screen. So the hub group is narrowed to the endpoints the hub attributed to
 * THIS person, which is the same positive test the Assets tree already applies
 * (`isAllocatedToUser`). One rule, two surfaces: a second copy would drift.
 *
 * The narrowing is PRESENTATION ONLY, and it stops at two rows it must never hide:
 *
 *  * the endpoint currently funding the harness, and
 *  * the endpoint the hub bound this box to.
 *
 * Both are routinely an org pool — that is the normal way a company funds a machine — and a
 * screen that omits what is actually paying is worse than the clutter it set out to remove.
 * A freshly pushed binding is the same case for a different reason: it arrives as a stub with
 * no principal at all (`_hub_stub`), so every attribution test says "not yours" until a listing
 * catches up.
 *
 * Deliberately NOT done in the backend. `_hub_user_typeid` says why in its own words: the
 * resolver legitimately spends a pool that belongs to an org, so dropping those rows from the
 * listing would break a spawn to tidy up a screen.
 */
import { LLMFundingKind, type LLMFundingStatus, type LLMSource } from '@sdk';

import { isAllocatedToUser } from '@src/components/llm-endpoints/my-endpoints';

import { endpointOf } from './use-llm-sources';

/**
 * The rows to render for `kind`, in the backend's own rank order.
 *
 * `funding` narrows to ONE kind, for a screen that renders per-kind groups. Omit it for every
 * visible row at once — a picker that shows one flat list must not enumerate the funding kinds
 * itself, or a fourth kind becomes a silent omission with no error anywhere.
 */
export function visibleSources(
  status: LLMFundingStatus | null | undefined,
  kind: string,
  funding?: LLMFundingKind,
): LLMSource[] {
  const inUse = status?.resolved?.[kind]?.endpoint_typeid ?? '';
  const bound = status?.endpoint_typeid ?? '';
  return (status?.sources?.[kind] ?? []).filter((source) => {
    const offer = endpointOf(status, source);
    if (funding && offer?.kind !== funding) return false;
    // Device logins and stored keys are per-machine facts with no principal to compare
    // against — there is nothing to narrow, and asking would rule every one of them out.
    if (offer?.kind !== LLMFundingKind.Hub) return true;
    if (source.endpoint_typeid === inUse || source.endpoint_typeid === bound) return true;
    return !!offer && isAllocatedToUser(offer, status?.hub_user_typeid);
  });
}
