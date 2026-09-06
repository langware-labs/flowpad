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
import {
  LLMFundingKind,
  llmSourceRef,
  sameLlmSource,
  selectKindFor,
  type LLMEndpointOffer,
  type LLMSource,
} from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertCircle, ArrowUpRight, Check, KeyRound, Waypoints } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import { openCredentials } from '@src/components/credentials-view/credentials-pointer';
import { openHarnessLoginModal } from '@src/components/harness-login/harness-login-store';
import { dotFor } from './llm-source-visuals';
import { openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { TONE } from '@src/components/llm-endpoints/tone';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import { openLlmSources, parseLlmSourcesPointer } from './llm-sources-pointer';
import { harnessKinds, labelForWorker, useLlmSources, useSelectSource, workerOf } from './use-llm-sources';
import { visibleSources } from './visible-sources';

function SourceRow({
  source,
  endpoint,
  harness,
  navigation,
  onSelect,
  inUse,
  busy,
}: {
  source: LLMSource;
  /** The row the verdict names. Undefined only if the backend listed a verdict whose endpoint
   *  it did not also send, which it never should — the row degrades rather than throwing. */
  endpoint: LLMEndpointOffer | undefined;
  harness: string;
  navigation: NavigationActions;
  /** Whether this row is what the resolver actually landed on. Comes from `status.resolved`,
   *  NOT from `source.auto`: these rows are offers, judged without the preference overlay, so
   *  `auto` here means "would win if nothing were chosen" — several rows can carry it. */
  inUse: boolean;
  onSelect: (s: LLMSource) => void;
  busy: boolean;
}) {
  const { t } = useLingui();
  const worker = workerOf(harness);
  // A signed-out device login cannot be picked here — signing in is the modal's job, and it owns
  // the vendor's paste-back flow. Without this the harness-status button would lead to a screen
  // that can only tell you it is signed out.
  //
  // Correct only because `source` is an OFFER: judged on the login itself, so ineligible means
  // signed out and nothing else. Fed the resolver's overlaid list this fired on a perfectly good
  // login that a preference had ruled out, and offered a Sign in button that could not help —
  // the one screen that could clear the preference refusing to.
  const needsSignIn = endpoint?.kind === LLMFundingKind.Device && !source.eligible;
  // The same escape hatch, one kind over. An unkeyed provider used to render the
  // problem ("no openrouter key is stored on this machine") beside a disabled
  // button and nothing else — a row that states a fix it will not let you make.
  // Adding the key belongs to Connections, which owns declaring a credential and
  // storing its value, so this sends you there rather than growing a second
  // place to type one.
  const needsKey = endpoint?.kind === LLMFundingKind.ApiKey && !source.eligible;
  return (
    <li
      className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
      data-testid={`llm-source-row-${worker}-${endpoint?.kind ?? 'unknown'}${endpoint?.provider ? `-${endpoint.provider}` : ''}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotFor(source)}`} title={source.authority} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{source.name}</span>
          {inUse && (
            <Badge variant="outline" className={TONE.emerald}>
              <Check className="mr-1 h-3 w-3" />
              <Trans>in use</Trans>
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
      {endpoint?.kind === LLMFundingKind.Hub && source.endpoint_typeid && (
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
        <Button
          size="sm"
          variant="outline"
          onClick={() => openHarnessLoginModal()}
          data-testid={`llm-source-signin-${worker}`}
        >
          <Trans>Sign in</Trans>
        </Button>
      ) : needsKey ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openCredentials(navigation)}
          title={t`Add this key under Connections`}
          data-testid={`llm-source-addkey-${worker}-${endpoint?.provider ?? 'unknown'}`}
        >
          <Trans>Add key</Trans>
        </Button>
      ) : (
        <Button
          size="sm"
          variant={inUse ? 'secondary' : 'outline'}
          disabled={!source.eligible || inUse || busy}
          onClick={() => onSelect(source)}
          data-testid={`llm-source-use-${worker}-${endpoint?.kind ?? 'unknown'}`}
        >
          {inUse ? <Trans>Using</Trans> : <Trans>Use</Trans>}
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
  // A verdict names an endpoint and mirrors none of its fields, so every render that wants a
  // kind, a provider or a model looks the row up here. Undefined only if the backend listed a
  // verdict whose endpoint it did not also send; callers degrade rather than throw.
  const endpointFor = useCallback((source: LLMSource) => status?.endpoints?.[source.endpoint_typeid], [status]);
  // Which source a harness actually landed on. The rows are offers and carry no such answer —
  // `auto` on an offer means "would win if nothing were chosen", which is true of several at once.
  const resolvedFor = useCallback((kind: string) => status?.resolved?.[kind] ?? undefined, [status]);
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
          // The pick endpoint still speaks the pre-endpoint vocabulary, so the row's kind is
          // translated back into it here. Phase 3 replaces the whole payload with the typeid.
          source: {
            kind: selectKindFor(endpointFor(source)?.kind ?? ''),
            provider: endpointFor(source)?.provider,
            endpoint_typeid: source.endpoint_typeid,
          },
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

  const GROUPS: [LLMFundingKind, string][] = useMemo(
    () => [
      [LLMFundingKind.Device, t`Device logins`],
      [LLMFundingKind.ApiKey, t`LLM keys`],
      [LLMFundingKind.Hub, t`Hub endpoints`],
    ],
    [t],
  );

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">{t`Loading…`}</div>;
  if (!status) {
    return (
      <div className="p-6 text-sm text-muted-foreground" data-testid="llm-sources-unavailable">
        <Trans>The funding picture is only available on a desktop instance.</Trans>
      </div>
    );
  }

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
              <div className="font-medium">{labelForWorker(chipWorker)}</div>
              {/* The backend owns this sentence too: `sources` is the un-overlaid offer list, so a
                  preference nothing can satisfy shows up here rather than on the rows. */}
              <div className="text-muted-foreground">
                {pick ? `→ ${pick.name}` : status.blocked[kind] || t`nothing eligible`}
              </div>
            </button>
          );
        })}
      </section>

      {/* A stated preference that is NOT in force — the box is signed out of Flowpad while
          Claude is set to use it. Sits above the list because it explains the whole page:
          without it the reader sees "use Flowpad" selected and something else plainly doing
          the spending, with nothing joining the two. Not an error — the harness IS funded,
          which is why it is a note and not the `blocked` sentence. */}
      {focused && status.notes?.[focused] && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-500"
          data-testid="llm-sources-note"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{status.notes[focused]}</span>
        </div>
      )}

      {focused && (
        <section className="flex flex-col gap-3" data-testid="llm-sources-list">
          {GROUPS.map(([kind, heading]) => {
            // Not `status.sources` directly: the hub group is narrowed to the budgets allocated
            // to this person, so an owner does not have to read past their org's and their teams'
            // pools to find their own. See `visible-sources.ts` for what it refuses to hide.
            const rows = visibleSources(status, focused, kind);
            if (!rows.length) return null;
            return (
              <div key={kind}>
                <h2 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {kind === LLMFundingKind.Hub ? <Waypoints className="h-3 w-3" /> : <KeyRound className="h-3 w-3" />}
                  {heading}
                </h2>
                <ul className="flex flex-col gap-1.5">
                  {rows.map((source) => (
                    <SourceRow
                      key={llmSourceRef(source)}
                      source={source}
                      endpoint={endpointFor(source)}
                      harness={focused}
                      navigation={navigation}
                      inUse={!!resolvedFor(focused) && sameLlmSource(source, resolvedFor(focused)!)}
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
