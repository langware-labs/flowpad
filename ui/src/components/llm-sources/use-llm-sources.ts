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
  type LLMFundingKind,
  type LLMFundingStatus,
  type LLMSource,
  type LLMSourceRef,
} from '@sdk';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

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

/**
 * Re-ask each harness whether it is signed in, on arrival at this page.
 *
 * `Capability.login_state` is runtime-only and is RESOLVED in exactly two
 * places: the backend's startup sweep, and the Assistants & keys modal's own
 * probe when it opens. Nothing else refreshes it — so a person who signs in to
 * the vendor CLI outside Flowpad (or in a Flowpad terminal) leaves this page
 * showing "signed out" indefinitely, and the device source it would pick stays
 * ineligible.
 *
 * That closes a loop rather than merely looking stale: a launch with no usable
 * source now routes HERE, and a page that cannot learn the truth sends the user
 * straight back to the failure that sent them.
 *
 * Same shape as the Capabilities view's arrival re-probe, one question over —
 * that one re-runs discovery to ask "is it installed", this one runs the
 * vendor's own check to ask "is it signed in".
 *
 * Failures are swallowed on purpose. An unreachable or unparseable probe leaves
 * `login_state` untouched by design (an undetermined answer is evidence about
 * the probe, not about the login), so the page keeps its last known state and
 * every row's own affordance still works.
 */
export function useRefreshLoginStates(): void {
  const qc = useQueryClient();
  const params = useFundingParams();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const probes = HARNESS_CAPABILITY_KINDS.map(async (kind) => {
        const capability = capabilityManager.getSnapshot(kind).capability;
        // `catch` per harness, not around the batch: one vendor CLI that hangs
        // or is missing must not stop the other three from reporting.
        await capability?.authStatus().catch(() => undefined);
      });
      await Promise.all(probes);
      // ONE refresh after all four, not one each — the funding status is a
      // single backend read covering every harness.
      if (!cancelled) await qc.invalidateQueries({ queryKey: lazyAssets.key(LazyAsset.LlmFunding, params) });
    })();
    return () => {
      cancelled = true;
    };
    // Mount only: this is an arrival probe, and re-running it on every params
    // change would spawn four vendor CLIs each time the active project moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Re-read the funding picture whenever a harness's login state moves.
 *
 * The reported symptom, and the one that made the page look broken: sign in from the modal
 * this page opens, succeed, and the device row still offers **Test** and **Sign in** — never
 * **Use**. The row's affordance is chosen by `source.eligible`, which the backend derives from
 * `login_state`; the login writes that field and broadcasts it, but the broadcast lands on
 * `capabilityManager` while this page renders from a SEPARATE react-query cache that nothing
 * told. `useRefreshLoginStates` is mount-only by design, so the page kept the snapshot it
 * arrived with for as long as it stayed open.
 *
 * Subscribing to the manager closes that gap at the seam where the news actually arrives,
 * rather than polling or re-probing: one invalidation per capability broadcast, and the row
 * re-renders from the same backend read every other answer on this page comes from.
 */
export function useFundingFollowsLogin(): void {
  const qc = useQueryClient();
  const params = useFundingParams();
  useEffect(
    () =>
      capabilityManager.subscribe(() => {
        void qc.invalidateQueries({ queryKey: lazyAssets.key(LazyAsset.LlmFunding, params) });
      }),
    [qc, params],
  );
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
  const mutation = useMutation({
    mutationFn: ({ source, endpoint, harness }: { source: LLMSource; endpoint?: LLMEndpointOffer; harness: string }) =>
      llmSourcesService.testSource({
        kind: endpoint?.kind ?? '',
        provider: endpoint?.provider,
        harness,
        endpoint_typeid: source.endpoint_typeid,
      }),
    onSettled: () => setPending(''),
    onSuccess: async (result: LLMEndpointTestResult) => {
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
    onError: (e) => notify.error({ title: i18n._(msg`Could not run the test`), message: String(e), durationMs: 4000 }),
  });
  return {
    /** Which row is mid-test, as an `llmSourceRef`; `''` when none is. */
    pending,
    test: (args: { source: LLMSource; endpoint?: LLMEndpointOffer; harness: string }) => {
      setPending(llmSourceRef(args.source));
      mutation.mutate(args);
    },
  };
}

/**
 * "I signed in elsewhere — look again."
 *
 * The one probe allowed to drop a recorded refusal. When a harness tells
 * FlowPad mid-turn that it is not logged in, that denial is latched, and a
 * SILENT re-check cannot clear it: `claude auth status` reports a credential's
 * presence, never its validity, so presence must not overturn a refusal the
 * harness actually made. `useRefreshLoginStates` is exactly that silent kind
 * and is correct to be.
 *
 * Which leaves the case this exists for, and which the backend's own docstring
 * names: a user who ran `claude /login` in their own terminal. The credential
 * is good, the latch says otherwise, and nothing a page does on its own may
 * disagree. `force` is the user asserting they fixed it — so it belongs on a
 * button they press, never on a render.
 *
 * The row showing "signed out" offered only Sign in, which starts a device
 * login nobody needs when they are already signed in. The cure lived on another
 * screen (the Assistants & keys Test button); this puts it where the problem is
 * reported.
 */
export function useRecheckSignIn() {
  const qc = useQueryClient();
  const params = useFundingParams();
  return useMutation({
    mutationFn: async (harnessKind: string) => {
      const capability = capabilityManager.getSnapshot(harnessKind).capability;
      if (!capability) throw new Error('no capability row for this harness');
      return capability.authStatus(true);
    },
    onSuccess: async (result) => {
      // The verdict came back; the funding picture is derived from it, so it has
      // to be re-read rather than patched — a cleared denial changes which
      // source WINS, not just one row's label.
      await qc.invalidateQueries({ queryKey: lazyAssets.key(LazyAsset.LlmFunding, params) });
      if (result.status === 'logged_in') {
        notify.success({ title: i18n._(msg`Signed in`), message: result.message || undefined, durationMs: 3000 });
      } else {
        notify.warning({
          title: i18n._(msg`Still signed out — please re-authenticate`),
          message: result.message || undefined,
          durationMs: 5000,
        });
      }
    },
    onError: () => notify.error({ title: i18n._(msg`Could not check sign-in`), durationMs: 4000 }),
  });
}
