/**
 * LLM sources — what funds each assistant on this machine, and why.
 *
 * URL: `/dock/llm-sources[/<worker>]`. A DESK page, not a hub one: a device token, a stored key
 * and the endpoint *binding* are all box facts, and the box action that produces them 404s on the
 * hub. The one hub-native part (an endpoint's chain, limits and usage) already has a hub page,
 * which the endpoint rows link out to.
 *
 * The list is the explanation. Every row renders the backend's own `reason` verbatim — this
 * screen never authors ineligibility text, because a second author drifts from the resolver and
 * then the picker and the spawn disagree.
 */
import { LLMSourceAuthority, LLMSourceKind, llmSourceRef, type LLMSource } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertCircle, ArrowUpRight, Check, KeyRound, Waypoints } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import { openHarnessLoginModal } from '@src/components/harness-login/harness-login-store';
import { openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { TONE } from '@src/components/llm-endpoints/tone';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { WORKER_LABELS, type WorkerType } from '@src/hooks/useWorkerHistory';
import { errorMessage } from '@src/lib/error-message';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import { openLlmSources, parseLlmSourcesPointer } from './llm-sources-pointer';
import { harnessKinds, useLlmSources, useSelectSource, workerOf } from './use-llm-sources';

/** How much the eligibility answer is worth. A probed device login is evidence; an endpoint we
 *  merely believe is reachable is not the same claim, and flattening them would let a caller
 *  treat an assumption as a fact. Keyed by the enum, so a new authority is a type error. */
const AUTHORITY_DOT: Record<LLMSourceAuthority, string> = {
  [LLMSourceAuthority.Proven]: 'bg-emerald-400',
  [LLMSourceAuthority.Cached]: 'bg-emerald-400/50',
  [LLMSourceAuthority.Presumed]: 'bg-amber-400/70',
};

/** Vendor label from the ONE table, falling back to the raw worker so a harness added to the
 *  capability registry renders as itself rather than not at all. */
function labelFor(worker: string): string {
  return WORKER_LABELS[worker as WorkerType] ?? worker;
}

function SourceRow({
  source,
  harness,
  navigation,
  onSelect,
  busy,
}: {
  source: LLMSource;
  harness: string;
  navigation: NavigationActions;
  onSelect: (s: LLMSource) => void;
  busy: boolean;
}) {
  const { t } = useLingui();
  const worker = workerOf(harness);
  // A signed-out device login cannot be picked here — signing in is the modal's job, and it owns
  // the vendor's paste-back flow. Without this the harness-status button would lead to a screen
  // that can only tell you it is signed out.
  const needsSignIn = source.kind === LLMSourceKind.Device && !source.eligible;
  return (
    <li
      className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
      data-testid={`llm-source-row-${worker}-${source.kind}${source.provider ? `-${source.provider}` : ''}`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${AUTHORITY_DOT[source.authority] ?? 'bg-muted-foreground/40'}`}
        title={source.authority}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{source.name}</span>
          {source.auto && (
            <Badge variant="outline" className={TONE.emerald}>
              <Check className="mr-1 h-3 w-3" />
              <Trans>in use</Trans>
            </Badge>
          )}
          {source.origin !== 'default' && (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              {source.origin}
            </Badge>
          )}
        </div>
        {/* The backend owns this sentence. Rendered verbatim, never rewritten here. */}
        {(source.reason || source.detail) && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            {source.reason && <AlertCircle className="h-3 w-3 text-amber-500" />}
            <span className="truncate">{source.reason || source.detail}</span>
          </div>
        )}
      </div>
      {source.kind === LLMSourceKind.Endpoint && source.endpoint_typeid && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openLlmEndpoint(navigation, source.endpoint_typeid)}
          title={t`Open this endpoint on the hub`}
        >
          <ArrowUpRight className="h-4 w-4" />
        </Button>
      )}
      {needsSignIn ? (
        <Button size="sm" variant="outline" onClick={() => openHarnessLoginModal()} data-testid={`llm-source-signin-${worker}`}>
          <Trans>Sign in</Trans>
        </Button>
      ) : (
        <Button
          size="sm"
          variant={source.auto ? 'secondary' : 'outline'}
          disabled={!source.eligible || source.auto || busy}
          onClick={() => onSelect(source)}
          data-testid={`llm-source-use-${worker}-${source.kind}`}
        >
          {source.auto ? <Trans>Using</Trans> : <Trans>Use</Trans>}
        </Button>
      )}
    </li>
  );
}

export function LlmSourcesView({ pointer }: { pointer?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { status, isLoading } = useLlmSources();
  const select = useSelectSource();

  const kinds = useMemo(() => harnessKinds(status), [status]);
  const worker = parseLlmSourcesPointer(pointer);
  // Matched against the kinds the box actually reported rather than rebuilt as
  // `harness.<worker>.cli`: a stale or hand-typed worker then falls back to the first harness
  // instead of yielding a kind that matches no chip and no source list. (The repo has an
  // incident on file from exactly that second copy of the vendor mapping — see
  // `navigation/open-capabilities.ts`.)
  const focused = kinds.find((kind) => workerOf(kind) === worker) ?? kinds[0];

  const onSelect = useCallback(
    async (harness: string, source: LLMSource) => {
      try {
        const next = await select.mutateAsync({
          harness,
          source: { kind: source.kind, provider: source.provider, endpoint_typeid: source.endpoint_typeid },
        });
        // Report what the resolver LANDED on, not what was asked for. A preference the ladder
        // cannot honour (picking an unproven device login on a box the hub has bound, say) is a
        // legitimate outcome, and saying "now using X" when X did not win is a plain lie.
        const landed = next.resolved[harness];
        notify.success({ title: t`Now using ${landed?.name ?? source.name}`, durationMs: 2500 });
      } catch (e) {
        notify.error({ title: t`Could not switch source`, message: errorMessage(e, '') });
      }
    },
    [select, t],
  );

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">{t`Loading…`}</div>;
  if (!status) {
    return (
      <div className="p-6 text-sm text-muted-foreground" data-testid="llm-sources-unavailable">
        <Trans>The funding picture is only available on a desktop instance.</Trans>
      </div>
    );
  }

  const GROUPS: [LLMSourceKind, string][] = useMemo(
    () => [
      [LLMSourceKind.Device, t`Device logins`],
      [LLMSourceKind.ApiKey, t`LLM keys`],
      [LLMSourceKind.Endpoint, t`Hub endpoints`],
    ],
    [t],
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6" data-testid="llm-sources-view">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound className="h-5 w-5" />
          <Trans>LLM sources</Trans>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <Trans>Where each assistant gets its model access, and why.</Trans>
        </p>
      </header>

      {/* The resolver's answer, one chip per harness — the same answer a spawn uses. */}
      <section className="flex flex-wrap gap-2" data-testid="llm-sources-resolution">
        {kinds.map((kind) => {
          const pick = status.resolved[kind];
          const chipWorker = workerOf(kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => openLlmSources(navigation, chipWorker)}
              className={`rounded-lg border px-3 py-2 text-left text-xs ${
                focused === kind ? 'border-primary/60 bg-primary/5' : 'border-border/60'
              }`}
              data-testid={`llm-sources-chip-${chipWorker}`}
            >
              <div className="font-medium">{labelFor(chipWorker)}</div>
              <div className="text-muted-foreground">{pick ? `→ ${pick.name}` : t`nothing eligible`}</div>
            </button>
          );
        })}
      </section>

      {focused && (
        <section className="flex flex-col gap-3" data-testid="llm-sources-list">
          {GROUPS.map(([kind, heading]) => {
            const rows = (status.sources[focused] ?? []).filter((s) => s.kind === kind);
            if (!rows.length) return null;
            return (
              <div key={kind}>
                <h2 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {kind === LLMSourceKind.Endpoint ? <Waypoints className="h-3 w-3" /> : <KeyRound className="h-3 w-3" />}
                  {heading}
                </h2>
                <ul className="flex flex-col gap-1.5">
                  {rows.map((source) => (
                    <SourceRow
                      key={llmSourceRef(source)}
                      source={source}
                      harness={focused}
                      navigation={navigation}
                      busy={select.isPending}
                      onSelect={(s) => void onSelect(focused, s)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
