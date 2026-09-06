import { lazyAssets, LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { useContext } from '@sdk/react/hooks';
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

import { WORKER_LABELS, type WorkerType } from '@src/hooks/useWorkerHistory';

/**
 * The funding picture, scoped to the ACTIVE PROJECT.
 *
 * The project is not decoration: a project may pin an endpoint, and that pin outranks the
 * user's own preference — so without it `resolved` reports the box-wide winner while every
 * process in the project spends something else. The backend applies the same rungs a spawn
 * applies (one `LLMScope`, one resolver), which is the whole point of passing it.
 *
 * `useContext()` is the same call the footer already makes for `version`; a null project is
 * the ordinary box-wide question, not an error.
 */
/**
 * The params every reader and writer of this asset must agree on.
 *
 * Shared because the cache key is built from them: a `setQueryData` that omitted the project
 * wrote to `[node, '']` while every observer sat on `[node, <project>]`, so the write landed
 * nowhere and the screen stayed stale until it refetched. One helper, so the read and the
 * write cannot address different entries.
 */
function useFundingParams() {
  const projectId = useContext().project?.id ?? undefined;
  return { projectId };
}

export function useLlmSources() {
  // Deliberately NOT `priority: 'background'`, though this read looks exactly like the
  // background widget that setting is for. `background` waits on `usePrimaryContentReady`,
  // which never fires on a shell/PTY page — measured: the footer chip AND the sibling
  // `IndexerStatusPill` (which does use `background`) are both absent there indefinitely. A
  // chip whose whole job is to be visible at rest cannot be invisible on the page type the
  // funding bug was reported from. The cost that motivated the idea was the per-harness
  // inventory fan-out, and that is fixed at the source instead (`_overlay` / `picker_view_for`
  // in `cli_drivers/llm_source.py` read the inventory once).
  const { data, isLoading } = useLazyAsset(LazyAsset.LlmFunding, useFundingParams());
  return { status: data ?? null, isLoading };
}

/** Choose which source funds a harness. One write, straight through the SDK — the page never
 *  touches `auth_mode` / `api_provider` itself, so the kind→fields mapping lives in Python. */
export function useSelectSource() {
  const qc = useQueryClient();
  const params = useFundingParams();
  return useMutation({
    mutationFn: ({ harness, source }: { harness: string; source: LLMSourceRef }) =>
      llmSourcesService.select(harness, source),
    onSuccess: (status) => {
      qc.setQueryData(lazyAssets.key(LazyAsset.LlmFunding, params), status);
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

/** Every source `kind` HAS, narrowed to one funding kind. These are offers — judged on their own
 *  credential, without the preference overlay — so `eligible` here means the source itself is
 *  usable, and "which one is in use" comes from `status.resolved` instead. */
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

/**
 * A vendor's display name, from the ONE table.
 *
 * Falls back to the raw worker so a harness added to the capability registry renders as
 * itself rather than not at all. Deliberately NOT via `providerKeyFor`, which falls back to
 * `'claude'` for anything it does not know — on a surface whose job is to say what funds a
 * run, silently relabelling an unknown harness as Claude is the one mistake to avoid.
 */
export function labelForWorker(worker: string): string {
  return WORKER_LABELS[worker as WorkerType] ?? worker;
}
