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
  llmSourceRef,
  llmSourcesService,
  type LLMEndpointOffer,
  type LLMEndpointTestResult,
  LLMFundingKind,
  type LLMFundingStatus,
  type LLMSource,
  type LLMSourceRef,
} from '@sdk';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { notify } from '@src/notifications';

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
  // A device login finishing, a vendor sign-out or a key change all reach the UI as a
  // capability change, but none of them touch this asset. Without the re-read, whatever
  // reads it (the footer chip's no-source alert) keeps its old answer until a reload.
  useEffect(() => capabilityManager.subscribe(() => void lazyAssets.invalidate(LazyAsset.LlmFunding)), []);
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
/** Whether a funding kind string names a hub endpoint. The one spelling of that comparison. */
function isHubKind(kind: string | undefined): boolean {
  return kind === (LLMFundingKind.Hub as string);
}

/** The hub endpoints this account may spend. */
export function hubOffers(status: LLMFundingStatus | null | undefined): LLMEndpointOffer[] {
  return (status?.available ?? []).filter((offer) => isHubKind(offer.kind));
}

/** The capability kinds a hub endpoint pays for, each with the endpoint typeid that pays. */
export function hubFunded(status: LLMFundingStatus | null | undefined): { kind: string; typeid: string }[] {
  return Object.entries(status?.resolved ?? {}).flatMap(([kind, pick]) =>
    pick && isHubKind(endpointOf(status, pick)?.kind) ? [{ kind, typeid: pick.endpoint_typeid }] : [],
  );
}

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

/**
 * "Does THIS row work?" — the per-source test.
 *
 * One button per row, because the three kinds fail for three unrelated reasons and a single
 * verdict cannot cover them. The Test this replaces ran `authStatus`, whose answer reports
 * WHAT FUNDS THE HARNESS: pressing it on a device login that had just signed in successfully
 * replied "using the hub endpoint" — an answer about a different row. Reported exactly that
 * way on Windows.
 *
 * Keyed by `llmSourceRef` so only the pressed row spins: `isPending` on a shared mutation
 * would grey out every Test button on the page for one row's call, and the key-and-hub checks
 * are real network calls that take a moment.
 */
export function useTestSource() {
  const qc = useQueryClient();
  const params = useFundingParams();
  const [pending, setPending] = useState<string>('');
  const [verdicts, setVerdicts] = useState<Record<string, LLMEndpointTestResult>>({});
  // The ref, not the state: `onSuccess` runs after `onSettled` has already cleared `pending`,
  // so reading the state there would file every verdict under the empty key.
  const pendingRef = useRef<string>('');
  const mutation = useMutation({
    mutationFn: ({ source, endpoint, harness }: { source: LLMSource; endpoint?: LLMEndpointOffer; harness: string }) =>
      llmSourcesService.testSource({
        kind: endpoint?.kind ?? '',
        provider: endpoint?.provider,
        harness,
        endpoint_typeid: source.endpoint_typeid,
        // A PERSON pressed this, so it may drop a latched refusal — the arrival probe, which
        // is automatic, may not. See `_test_device_login`.
        force: true,
      }),
    onSettled: () => setPending(''),
    onSuccess: async (result: LLMEndpointTestResult) => {
      // The verdict lands ON THE ROW, not only in a toast. Reported: pressing Test showed a
      // spinner, then the button came back, and nothing else — the toast was either missed or
      // never seen, and a test whose answer you cannot find has not answered. The row keeps
      // its verdict until the next press.
      setVerdicts((prior) => ({ ...prior, [pendingRef.current]: result }));
      // A device test can flip `login_state`, and a key that turns out to be dead changes
      // which source WINS — so the funding picture is re-read rather than patched.
      await qc.invalidateQueries({ queryKey: lazyAssets.key(LazyAsset.LlmFunding, params) });
      if (result.ok) {
        notify.success({
          title: i18n._(msg`This source works`),
          message: result.model ? `${result.model} · ${result.latency_ms}ms` : undefined,
          durationMs: 3000,
        });
      } else {
        // The provider's own sentence, verbatim. "Insufficient credit" and "invalid key" are
        // different problems with different cures, and only it knows which this is.
        notify.warning({ title: i18n._(msg`This source did not work`), message: result.message, durationMs: 6000 });
      }
    },
    onError: (e) => {
      // A transport failure is still an answer the row must show, for the same reason: the
      // button coming back with nothing beside it reads as "the test did nothing".
      setVerdicts((prior) => ({
        ...prior,
        [pendingRef.current]: { ok: false, status: 0, model: '', latency_ms: 0, message: String(e) },
      }));
      notify.error({ title: i18n._(msg`Could not run the test`), message: String(e), durationMs: 4000 });
    },
  });
  return {
    /** Which row is mid-test, as an `llmSourceRef`; `''` when none is. */
    pending,
    /** The last verdict per row, by `llmSourceRef` — rendered on the row itself. */
    verdicts,
    test: (args: { source: LLMSource; endpoint?: LLMEndpointOffer; harness: string }) => {
      const ref = llmSourceRef(args.source);
      pendingRef.current = ref;
      setPending(ref);
      // Drop the previous verdict as the new run starts: a stale green beside a spinner claims
      // an answer this press has not produced yet.
      setVerdicts((prior) => Object.fromEntries(Object.entries(prior).filter(([key]) => key !== ref)));
      mutation.mutate(args);
    },
  };
}
