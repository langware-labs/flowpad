/**
 * This machine's endpoints: a provider key stored here IS a root endpoint, shown in the same table,
 * detail and dialog as a hub root (the API keys tab is where they live).
 *
 * The rows come from the funding record's `available` list (`kind: api_key`, written by the
 * backend's `LLMEndpoint.key_endpoints()`); the masked hint comes from the status record, which is
 * the only place that knows it. A hub-only runtime has no machine, so it has none.
 */
import { LLMEndpoint, LLMFundingKind, dataContext, lmKeysService, type LMApiProvider } from '@sdk';
import { lazyAssets, LazyAsset } from '@sdk/lazy';
import { useMemo } from 'react';

import { invalidateLlmFunding, useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { useStatusRecord } from '@src/components/status/use-status-record';

export function useLocalEndpoints(): LLMEndpoint[] {
  const { status } = useLlmSources();
  const { status: record } = useStatusRecord();
  return useMemo(() => {
    if (!dataContext.caps.localFiles) return [];   // a machine with a disk holds keys; the hub does not
    const hints = new Map((record?.keys ?? []).filter((k) => k.stored).map((k) => [k.provider, k.hint ?? '']));
    return (status?.available ?? [])
      .filter((offer) => offer.kind === (LLMFundingKind.ApiKey as string) && hints.has(offer.provider))
      .map(({ id, name, provider, enabled, base_url, tiers, limits, filters }) =>
        // Only the entity's own fields: the offer's `kind` is a funding kind, and on the entity
        // `kind` is a derived getter (root/chain).
        new LLMEndpoint({
          id, name, provider, enabled, base_url, tiers, limits, filters,
          credential_hint: hints.get(provider) || '****',
        } as never),
      );
  }, [status, record]);
}

/** A key changes what can pay: both records re-read. */
export function invalidateLocalEndpoints(): void {
  void lazyAssets.invalidate(LazyAsset.Status);
  invalidateLlmFunding();
}

export async function deleteLocalEndpoint(endpoint: LLMEndpoint): Promise<void> {
  await lmKeysService.deleteLmApi(endpoint.provider as LMApiProvider);
  invalidateLocalEndpoints();
}

/** The providers a key can be stored for on this machine (`LMApiProvider`, minus the hub login). */
export const LOCAL_PROVIDERS = ['openrouter', 'anthropic', 'openai'] as const;
