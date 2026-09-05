import { lazyAssets, LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
/**
 * The box's funding picture, as one cached read.
 *
 * Everything the page renders — the per-harness source lists, which one wins, the endpoints on
 * offer — comes from a single backend call, because the resolver that answers it is the same one
 * a spawn uses. Deriving "which source wins" in the client would put the resolver in two places
 * and let them disagree, which is exactly the drift a stale `login_state` caused once.
 */
import {
  capabilityManager,
  HARNESS_CAPABILITY_KINDS,
  llmSourcesService,
  type LLMEndpointOffer,
  type LLMFundingKind,
  type LLMFundingStatus,
  type LLMSource,
  type LLMSourceRef,
} from '@sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';

export const LLM_SOURCES_KEY = ['lazy', LazyAsset.LlmFunding] as const;

export function useLlmSources() {
  const { data, isLoading } = useLazyAsset(LazyAsset.LlmFunding);
  return { status: data ?? null, isLoading };
}

/** Choose which source funds a harness. One write, straight through the SDK — the page never
 *  touches `auth_mode` / `api_provider` itself, so the kind→fields mapping lives in Python. */
export function useSelectSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ harness, source }: { harness: string; source: LLMSourceRef }) =>
      llmSourcesService.select(harness, source),
    onSuccess: (status) => {
      qc.setQueryData(lazyAssets.key(LazyAsset.LlmFunding), status);
      // `select` writes the same `auth_mode` / `api_provider` that `capabilityManager.setAuthMode`
      // does, but server-side — so it bypasses that manager's own invalidation. Everything else
      // that shows a harness's auth mode (the login modal, the footer warnings, the terminal
      // strip) reads `capabilityManager.getSnapshot`, and would keep showing the previous source
      // until something unrelated reloaded it. One write, one cache refresh.
      // Fire-and-forget: awaiting it would hold `isPending` (and every row's button) for an
      // extra round-trip after the write already landed.
      void capabilityManager.load(true);
    },
  });
}

/** Harness kinds in display order, filtered to those the box actually reported. */
export function harnessKinds(status: LLMFundingStatus | null | undefined): string[] {
  const known = new Set(Object.keys(status?.sources ?? {}));
  return HARNESS_CAPABILITY_KINDS.filter((kind) => known.has(kind));
}

/**
 * The endpoint a verdict names.
 *
 * A verdict mirrors none of the endpoint's fields — it carries a typeid and the
 * judgement — so every caller that wants a kind, a provider or a model looks the
 * row up here. Lives beside `harnessKinds`/`workerOf` because it is the same kind
 * of plain function over the payload, and because the source→endpoint indirection
 * is documented as in flux: one place to change beats three.
 */
export function endpointOf(
  status: LLMFundingStatus | null | undefined,
  source: LLMSource | undefined,
): LLMEndpointOffer | undefined {
  return source ? status?.endpoints?.[source.endpoint_typeid] : undefined;
}

/** Every source that could fund `kind`, narrowed to one funding kind. */
export function sourcesOfKind(
  status: LLMFundingStatus | null | undefined,
  kind: string,
  funding: LLMFundingKind,
): LLMSource[] {
  return (status?.sources?.[kind] ?? []).filter((s) => endpointOf(status, s)?.kind === funding);
}

/** `harness.claude.cli` → `claude`. */
export function workerOf(kind: string): string {
  return kind.split('.')[1] ?? kind;
}
