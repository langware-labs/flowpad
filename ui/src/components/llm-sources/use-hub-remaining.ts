/**
 * What is LEFT on the hub endpoints a box is spending — one chain read per endpoint.
 *
 * The funding record names the endpoints but carries no usage: limits live on the row, and the
 * sums the limit gate keeps live on the hub. The hub's `chain` action already returns both
 * (`remaining` per limit, per hop), so "$2.58 left" is one GET away. Read here, UI-side, rather
 * than folded into the funding record: that record is served from local rows and must stay a
 * warm read, and a hub round-trip per endpoint inside it would make every status screen wait
 * on the network.
 *
 * Through the BOX (`llmSourcesService.chain`), never the hub's own `chain` action: a desktop has
 * no row for a hub endpoint, so the hub-page fetcher answers "Entity not found" here. The sources
 * page's Test goes the same way, for the same reason.
 */
import { llmSourcesService, type LLMFundingStatus } from '@sdk';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { isHubOnly } from '@src/navigation/hub-runtime';
import { endpointIdFromTypeId, endpointTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { tightestCostLimit, type CostLeftByEndpoint } from '@src/components/llm-endpoints/usage-math';
import type { LLMChain } from '@sdk';

import { hubFunded, hubOffers } from './use-llm-sources';

/**
 * Which endpoints to read: only the ones a harness is SPENDING (`in-use` — all a summary row
 * shows), or every one on offer (`all` — the endpoints section lists each with its bar).
 */
export type HubRemainingScope = 'in-use' | 'all';

/** The distinct hub endpoint typeids in scope, in a stable order. */
export function hubEndpointTypeIds(
  funding: LLMFundingStatus | null | undefined,
  scope: HubRemainingScope = 'all',
): string[] {
  const out = new Set(hubFunded(funding).map(({ typeid }) => typeid));
  if (scope === 'all') for (const offer of hubOffers(funding)) out.add(endpointTypeId(offer.id));
  return [...out];
}

/** Cost left (tightest cap) per hub endpoint typeid; `null` until read or when uncapped. */
export function useHubRemaining(
  funding: LLMFundingStatus | null | undefined,
  scope: HubRemainingScope = 'all',
): CostLeftByEndpoint {
  const typeids = useMemo(() => hubEndpointTypeIds(funding, scope), [funding, scope]);
  const combine = useCallback(
    (results: UseQueryResult<LLMChain>[]): CostLeftByEndpoint =>
      Object.fromEntries(typeids.map((typeid, i) => [typeid, tightestCostLimit(results[i]?.data?.hops)])),
    [typeids],
  );
  return useQueries({
    queries: typeids.map((typeid) => {
      const id = endpointIdFromTypeId(typeid);
      return {
        queryKey: ['llm-sources', 'chain', id],
        queryFn: () => llmSourcesService.chain(id),
        enabled: !isHubOnly(),
        staleTime: 15_000,
      };
    }),
    combine,
  });
}
