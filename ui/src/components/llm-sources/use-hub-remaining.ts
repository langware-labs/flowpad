/**
 * What is LEFT on the hub endpoints a box is spending — one chain read per endpoint.
 *
 * The funding record names the endpoints but carries no usage: limits live on the row, and the
 * sums the limit gate keeps live on the hub. The hub's `chain` action already returns both
 * (`remaining` per limit, per hop), and the box proxies it, so a pill that says "$2.58 left"
 * is one GET away. Read here, UI-side, rather than folded into the funding record: that record
 * is served from local rows and must stay a warm read, and a hub round-trip per endpoint inside
 * it would make every status screen wait on the network.
 *
 * Through the BOX (`llmSourcesService.chain`), never the hub's own `chain` action: a desktop has
 * no row for a hub endpoint, so the hub-page fetcher answers "Entity not found" here. The sources
 * page's Test goes the same way, for the same reason.
 */
import { llmSourcesService, type LLMFundingStatus } from '@sdk';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { isHubOnly } from '@src/navigation/hub-runtime';
import { endpointIdFromTypeId, endpointTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { tightestCostLimit, type RemainingByEndpoint } from '@src/components/harness-login/funding-pill';

import { endpointOf } from './use-llm-sources';

const HUB = 'hub';

/** The distinct hub endpoint typeids a funding record spends or offers, in a stable order. */
export function hubEndpointTypeIds(funding: LLMFundingStatus | null | undefined): string[] {
  const out = new Set<string>();
  for (const pick of Object.values(funding?.resolved ?? {})) {
    if (pick && endpointOf(funding, pick)?.kind === HUB) out.add(pick.endpoint_typeid);
  }
  for (const offer of funding?.available ?? []) {
    if (offer.kind === HUB) out.add(endpointTypeId(offer.id));
  }
  return [...out];
}

/** Remaining (tightest cost cap) per hub endpoint typeid; `null` until read or when uncapped. */
export function useHubRemaining(funding: LLMFundingStatus | null | undefined): RemainingByEndpoint {
  const typeids = useMemo(() => hubEndpointTypeIds(funding), [funding]);
  const results = useQueries({
    queries: typeids.map((typeid) => {
      const id = endpointIdFromTypeId(typeid);
      return {
        queryKey: ['llm-sources', 'chain', id],
        queryFn: () => llmSourcesService.chain(id),
        enabled: !isHubOnly(),
        staleTime: 15_000,
      };
    }),
  });
  return useMemo(() => {
    const out: RemainingByEndpoint = {};
    typeids.forEach((typeid, i) => {
      out[typeid] = tightestCostLimit(results[i]?.data?.hops);
    });
    return out;
    // `results` is a fresh array each render; the data inside is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeids, ...results.map((r) => r.data)]);
}
