/**
 * "A call through this endpoint succeeded — but WHOSE key paid for it?"
 *
 * A green tick on the Test button answers the wrong half of the question. A person looking
 * at it cannot tell a working budget from a working *something else*: this machine also
 * holds vendor OAuth sessions and stored provider keys, and those fund the harnesses that
 * actually run. So the tick is stated together with its provenance.
 *
 * Two facts, deliberately kept apart, because they can legitimately disagree:
 *
 *  1. **What the test spent.** Structurally the endpoint's own chain: `test` is executed BY
 *     THE HUB down the resolved chain (`test_action` → `_forward`, the same path as
 *     `invoke`), with the provider key attached to whichever root that chain ends at. This
 *     box's OAuth sessions and sod-stored keys are not reachable from there, so a green
 *     verdict cannot be one of those wearing the endpoint's name — and a chain with no
 *     key-holding root answers 503 rather than falling back. The chain report names the root
 *     so the claim is checkable rather than asserted.
 *
 *  2. **What this machine is using right now.** The resolver's own answer per harness, off
 *     the same status read the LLM-sources screen uses. This is the one that says "your
 *     agent is on an OAuth login, not on this budget" — the thing a passing test does NOT
 *     prove, and the reason both blocks are here.
 */
import {
  LLMFundingKind,
  isHubOnly,
  llmSourcesService,
  type LLMChain,
  type LLMEndpointOffer,
  type LLMEndpointTestResult,
} from '@sdk';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useQuery } from '@tanstack/react-query';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, KeyRound, ShieldAlert, X } from 'lucide-react';

import { WORKER_LABELS, type WorkerType } from '@src/hooks/useWorkerHistory';
import { harnessKinds, useLlmSources, workerOf } from '@src/components/llm-sources/use-llm-sources';

import { endpointIdFromTypeId } from './llm-endpoints-pointer';
import { TONE } from './tone';

/** The root a call ends at: the one this caller is stuck to when the hub says so, else the
 *  end of the first fallback path (`paths` is entry→root, in fallback order). Null while the
 *  chain is unread — never guessed. Exported for the unit test. */
export function payingRoot(chain: LLMChain | null | undefined): LLMChain['hops'][number] | null {
  if (!chain) return null;
  const firstPath = chain.paths?.[0] ?? [];
  const rootId = chain.sticky_root_for_me || firstPath[firstPath.length - 1];
  return chain.hops?.find((hop) => hop.id === rootId) ?? null;
}

/** The chain, read through the box (the hub's own `chain` action is unreachable from a
 *  desktop). Skipped in hub mode, where the endpoints screen already draws the whole tree. */
function useEndpointChain(endpointId: string) {
  return useQuery({
    queryKey: ['llm-endpoint', 'box-chain', endpointId],
    queryFn: () => llmSourcesService.chain(endpointId),
    enabled: !!endpointId && !isHubOnly(),
    staleTime: 30_000,
    retry: false,
  });
}

export interface FundingProvenanceProps {
  endpoint: LLMEndpointOffer;
  /** The last verdict from the Test button, or null before one is run. */
  verdict: LLMEndpointTestResult | null;
}

export function FundingProvenance({ endpoint, verdict }: FundingProvenanceProps) {
  const { t } = useLingui();
  const { data: chain, isError: chainFailed } = useEndpointChain(endpoint.id);
  const { status } = useLlmSources();
  const root = payingRoot(chain);
  // Hop ids are typeids and the row's own id is bare; comparing them raw never matches.
  const isOwnRoot = !!root && endpointIdFromTypeId(root.id) === endpoint.id;

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="llm-funding-provenance">
      {/* 1 — what a call through this endpoint spends. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-muted-foreground">
          <Trans>A call here spends</Trans>
        </span>
        {root ? (
          <span className="inline-flex items-center gap-1.5" data-testid="llm-funding-root">
            <KeyRound className="h-3.5 w-3.5" />
            <span className="font-medium">
              {isOwnRoot ? <Trans>this endpoint's own key</Trans> : root.name || root.id}
            </span>
            {root.provider && <span className="font-mono text-xs text-muted-foreground">{root.provider}</span>}
            {!root.has_credential && (
              <span className={`rounded border px-1.5 py-0.5 text-[11px] ${TONE.amber}`}>
                <Trans>no key on that root</Trans>
              </span>
            )}
          </span>
        ) : chainFailed ? (
          // The chain is an extra hub read and may simply be unavailable; the transport claim
          // below does not depend on it, so say what is unknown instead of hiding the block.
          <span className="text-muted-foreground" data-testid="llm-funding-root-unknown">
            <Trans>a key the hub holds (the chain could not be read from here)</Trans>
          </span>
        ) : (
          <span className="text-muted-foreground">
            <Trans>…</Trans>
          </span>
        )}
      </div>

      {/* The claim that makes a green tick mean something. Always shown: it is true of the
          transport itself, not of any particular run. */}
      <p className="text-xs text-muted-foreground" data-testid="llm-funding-transport">
        <Trans>
          The hub makes this call itself, down this endpoint's chain. A vendor OAuth login or an API key stored on this
          machine is never used for it — with no key-holding root the test fails rather than falling back.
        </Trans>
      </p>

      {/* 2 — the run that just happened, named so the two cannot be conflated. */}
      {verdict && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="llm-funding-verdict">
          {verdict.ok ? (
            <Check className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <X className="h-3.5 w-3.5 text-destructive" />
          )}
          <span className={verdict.ok ? 'text-emerald-600' : 'text-destructive'}>
            {verdict.ok ? t`Last test paid with that key` : t`Last test failed`}
          </span>
          <span className="font-mono text-muted-foreground">
            {verdict.status || '—'}
            {verdict.model ? ` · ${verdict.model}` : ''}
            {verdict.latency_ms ? ` · ${verdict.latency_ms}ms` : ''}
          </span>
          {!verdict.ok && verdict.message && <span className="text-muted-foreground">{verdict.message}</span>}
        </p>
      )}

      {/* 3 — and what the machine is ACTUALLY on, which a passing test does not prove. */}
      <HarnessFunding endpointId={endpoint.id} status={status} />
    </div>
  );
}

/** Per harness: the source the resolver picks today, in the same words the LLM-sources
 *  screen uses. Silent when the box reports no harnesses (hub mode, or nothing installed) —
 *  an empty list is not a finding. */
function HarnessFunding({
  endpointId,
  status,
}: {
  endpointId: string;
  status: ReturnType<typeof useLlmSources>['status'];
}) {
  const { t } = useLingui();
  const kinds = harnessKinds(status);
  if (!status || kinds.length === 0) return null;
  return (
    <div className="space-y-0.5 border-t pt-2" data-testid="llm-funding-harnesses">
      <div className="text-xs text-muted-foreground">
        <Trans>What this machine's assistants are funded by right now</Trans>
      </div>
      {kinds.map((kind) => {
        const picked = status.resolved?.[kind] ?? null;
        const offer = picked ? status.endpoints?.[picked.endpoint_typeid] : undefined;
        const mine = !!offer && offer.id === endpointId;
        return (
          <div key={kind} className="flex flex-wrap items-baseline gap-2 text-xs" data-testid={`llm-funding-${kind}`}>
            <span className="w-24 shrink-0 text-muted-foreground">
              {WORKER_LABELS[workerOf(kind) as WorkerType] ?? workerOf(kind)}
            </span>
            <span className={mine ? 'text-emerald-600' : undefined}>{t(fundingLabel(offer, mine))}</span>
            {!mine && offer?.kind === LLMFundingKind.Device && <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />}
          </div>
        );
      })}
    </div>
  );
}

/** The one place a funding kind becomes a sentence. `mine` is the answer the reader came
 *  for: whether the budget on screen is the thing paying. Exported for the unit test. */
export function fundingLabel(offer: LLMEndpointOffer | undefined, mine: boolean): MessageDescriptor {
  if (mine) return msg`this budget`;
  if (!offer) return msg`nothing eligible`;
  const label = offer.name || offer.provider || offer.id;
  // `LLMEndpointOffer.kind` is the wire's `string` (it is whatever the box sent); the enum is
  // what those three values MEAN. Naming that here is what lets the switch be exhaustive.
  switch (offer.kind as LLMFundingKind) {
    case LLMFundingKind.Hub:
      return msg`another hub budget — ${label}`;
    case LLMFundingKind.ApiKey:
      return msg`a ${label} key stored on this machine`;
    case LLMFundingKind.Device:
      return msg`a ${label} OAuth login on this machine`;
    default:
      return msg`${label}`;
  }
}
