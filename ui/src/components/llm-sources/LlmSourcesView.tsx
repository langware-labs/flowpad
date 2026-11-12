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
  llmSourcesService,
  sameLlmSource,
  selectKindFor,
  type DecisionApi,
  type LLMEndpointOffer,
  type LLMSource,
  remedyFor,
  LLMSourceRefusal,
} from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertCircle, ArrowLeft, ArrowUpRight, Check, KeyRound, Loader2, Route, Waypoints } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import { openHarnessSignIn } from '@src/components/harness-login/harness-sign-in-store';
import { useRefreshStatusOnArrival, useStatusRecord } from '@src/components/status/use-status-record';
import { dotFor } from './llm-source-visuals';
import { openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { TONE } from '@src/components/llm-endpoints/tone';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import { LlmEndpointsView } from '@src/components/llm-endpoints/LlmEndpointsView';
import { llmEndpointsPointer, type LlmEndpointTab } from '@src/components/llm-endpoints/llm-endpoints-pointer';

import { EndpointSponsorLine } from './EndpointSponsorLine';
import { Tabs, TabsList, TabsTrigger } from '@src/components/ui/tabs';

import { LoginsTable } from './LoginsTable';
import { LLM_SOURCES_TABS, openLlmSources, parseLlmSourcesTab, type LlmSourcesTab } from './llm-sources-pointer';
import {
  harnessKinds,
  labelForWorker,
  resolvedLabel,
  useLlmSources,
  useTestSource,
  useSelectSource,
  workerOf,
  hubOffers,
} from './use-llm-sources';
import { keysSummary } from '@src/components/harness-login/funding-pill';
import { visibleSources } from './visible-sources';

/**
 * The decision API — box-wide, so it sits beside the per-harness picture rather than inside
 * it. Available means the magic line can open a screen without starting an assistant turn;
 * not available means every ask takes the ordinary path, which is why the reason reads as a
 * fact, not an error. The sentence is the backend's, verbatim.
 */
function DecisionApiRow({ decision }: { decision: DecisionApi }) {
  return (
    <section
      className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2"
      data-testid="llm-sources-decision"
    >
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${decision.available ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Route className="h-3.5 w-3.5" />
          <Trans>Decision API</Trans>
          {decision.available && (
            <Badge variant="outline" className={TONE.emerald} data-testid="llm-sources-decision-available">
              <Trans>available</Trans>
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          {decision.available ? (
            <span className="truncate">
              {decision.name}
              {decision.host ? ` · ${decision.host}` : ''} —{' '}
              <Trans>quick requests open without an assistant turn</Trans>
            </span>
          ) : (
            <>
              <AlertCircle className="h-3 w-3 shrink-0 text-amber-500" />
              <span className="truncate" data-testid="llm-sources-decision-reason">
                {decision.reason}
              </span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function SourceRow({
  source,
  endpoint,
  harness,
  navigation,
  onSelect,
  inUse,
  busy,
  testSource,
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
  /** The page's one test runner, shared so only the pressed row spins. */
  testSource: ReturnType<typeof useTestSource>;
}) {
  const { t } = useLingui();
  const worker = workerOf(harness);
  const testing = testSource.pending === llmSourceRef(source);
  const verdict = testSource.verdicts[llmSourceRef(source)];
  // A signed-out device login cannot be picked here — signing in is the modal's job, and it owns
  // the vendor's paste-back flow. Without this the harness-status button would lead to a screen
  // that can only tell you it is signed out.
  //
  // Read off the backend's refusal CODE, never inferred from the endpoint's kind: an
  // uninstalled CLI and a preference that ruled a good login out are both ineligible device
  // rows, and neither is fixed by signing in.
  const remedy = remedyFor(source.reason_code);
  const needsSignIn = remedy === 'sign_in';
  // The same escape hatch, one kind over. An unkeyed provider used to render the
  // problem ("no openrouter key is stored on this machine") beside a disabled
  // button and nothing else — a row that states a fix it will not let you make.
  // Adding the key belongs to Connections, which owns declaring a credential and
  // storing its value, so this sends you there rather than growing a second
  // place to type one.
  const needsKey = remedy === 'add_key';
  return (
    <li
      className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
      data-testid={`llm-source-row-${worker}-${endpoint?.kind ?? 'unknown'}${endpoint?.provider ? `-${endpoint.provider}` : ''}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotFor(source)}`} title={source.authority} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{source.name}</span>
          {source.reason_code === LLMSourceRefusal.KeyRejected ? (
            <Badge
              variant="outline"
              className="border-destructive/40 text-destructive"
              title={source.reason || undefined}
              data-testid={`llm-source-rejected-${worker}`}
            >
              <Trans>Rejected</Trans>
            </Badge>
          ) : inUse && (
            <Badge variant="outline" className={TONE.emerald}>
              <Check className="mr-1 h-3 w-3" />
              <Trans>in use</Trans>
            </Badge>
          )}
        </div>
        {/* The last test's answer, ON THE ROW. Reported: Test showed a spinner, the button
            came back, and nothing else — so a source that is simply not signed in looked
            identical to one that passed. Sits above the backend's standing sentence because
            it is the newer, more specific fact: that sentence describes the row at the last
            read, this describes what happened when the row was actually exercised. */}
        {verdict && (
          <div
            className={`mt-0.5 flex items-center gap-1 text-xs ${verdict.ok ? 'text-emerald-600 dark:text-emerald-500' : 'text-amber-600 dark:text-amber-500'}`}
            data-testid={`llm-source-verdict-${worker}-${endpoint?.kind ?? 'unknown'}`}
          >
            {verdict.ok ? <Check className="h-3 w-3 shrink-0" /> : <AlertCircle className="h-3 w-3 shrink-0" />}
            <span className="truncate">
              {verdict.ok ? (
                <Trans>Test passed — this source can fund a run</Trans>
              ) : (
                // The provider's own sentence when there is one: "insufficient credits" and
                // "invalid key" have different cures and only it knows which this is.
                verdict.message || <Trans>Test failed — this source cannot fund a run right now</Trans>
              )}
            </span>
          </div>
        )}
        {/* The backend owns this sentence. Rendered verbatim, never rewritten here.
            `detail` is suppressed under a FAILED verdict: it is the softer of the two
            ("signed in", "sign-in not checked") and describes the row as of the last read,
            so a just-failed test left the row contradicting itself in two stacked lines —
            "claude CLI is not logged in." above "signed in". `reason` is kept either way:
            that is a refusal, and two refusals do not disagree. */}
        {(source.reason || (verdict && !verdict.ok ? '' : source.detail)) && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            {source.reason && <AlertCircle className="h-3 w-3 text-amber-500" />}
            <span className="truncate">{source.reason || (verdict && !verdict.ok ? '' : source.detail)}</span>
          </div>
        )}
        {endpoint?.kind === LLMFundingKind.Hub && source.endpoint_typeid && (
          <div className="mt-0.5 flex">
            <EndpointSponsorLine typeid={source.endpoint_typeid} />
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
      {/* EVERY row tests itself. The three kinds fail for three unrelated reasons — a device
          login is signed out, a stored key is revoked or out of credit, a hub endpoint is
          unbound or spent — so a verdict is only meaningful when the row asking is the row
          answering. The single Test this replaces lived on the signed-out device row alone
          and ran `authStatus`, whose answer reports WHAT FUNDS THE HARNESS: pressed after a
          successful sign-in it said "using the hub endpoint", an answer about a different
          row entirely. The key and hub checks each send one minimal completion, so a green
          verdict means tokens were really bought and not merely that a credential exists. */}
      <Button
        size="sm"
        variant="ghost"
        disabled={testing}
        onClick={() => testSource.test({ source, endpoint, harness })}
        title={t`Does this source actually work?`}
        data-testid={`llm-source-test-${worker}-${endpoint?.kind ?? 'unknown'}${endpoint?.provider ? `-${endpoint.provider}` : ''}`}
      >
        {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trans>Test</Trans>}
      </Button>
      {needsSignIn ? (
        /* No Re-check beside it. It asked `authStatus`, whose answer reports what FUNDS the
           harness rather than whether this login works — so on a signed-out row it announced
           the hub endpoint, which is not what the button appeared to offer. The arrival probe
           now answers the "did I sign in elsewhere" case without being asked, and Test answers
           it on demand, so nothing is lost with it. */
        <Button
          size="sm"
          variant="outline"
          onClick={() => openHarnessSignIn(harness)}
          data-testid={`llm-source-signin-${worker}`}
        >
          <Trans>Sign in</Trans>
        </Button>
      ) : needsKey ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigation.openCredentials()}
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
  const { status: record } = useStatusRecord();
  // Re-check every harness now (local probes, no money): the only way this page can be right
  // about a login the user ended in their own terminal. A sign-in made from the modal this page
  // opens then flips the row through the backend's status push — nothing here follows it.
  useRefreshStatusOnArrival();
  const select = useSelectSource();
  // One runner for the whole page: it carries which row is mid-test, so a shared `isPending`
  // cannot grey out every other row's Test button while one real network call is in flight.
  const testSource = useTestSource();

  const kinds = useMemo(() => harnessKinds(status), [status]);
  // The same two counts the Assistants & keys rows show, from the same two helpers.
  const keys = keysSummary(record);
  const hubCount = hubOffers(status).length;
  // A verdict names an endpoint and mirrors none of its fields, so every render that wants a
  // kind, a provider or a model looks the row up here. Undefined only if the backend listed a
  // verdict whose endpoint it did not also send; callers degrade rather than throw.
  const endpointFor = useCallback((source: LLMSource) => status?.endpoints?.[source.endpoint_typeid], [status]);
  // Which source a harness actually landed on. The rows are offers and carry no such answer —
  // `auto` on an offer means "would win if nothing were chosen", which is true of several at once.
  const resolvedFor = useCallback((kind: string) => status?.resolved?.[kind] ?? undefined, [status]);
  // `<tab>[/<rest>]`: the tab, and below it an assistant (Logins) or an endpoint (the two endpoint tabs).
  const { tab, rest } = parseLlmSourcesTab(pointer);
  // Matched against the kinds the box actually reported rather than rebuilt as
  // `harness.<worker>.cli`: a stale or hand-typed worker then shows the Logins table instead of a
  // kind that matches no source list.
  const focused = tab === 'logins' && rest ? (kinds.find((kind) => workerOf(kind) === rest) ?? null) : null;
  // The open endpoint tab embeds the shared endpoints view; its drill-down stays in this URL.
  const embed = useMemo(
    () => ({
      go: (id?: string, sub?: LlmEndpointTab) =>
        openLlmSources(navigation, [tab, id ? llmEndpointsPointer(id, sub) : ''].filter(Boolean).join('/')),
    }),
    [navigation, tab],
  );
  const counts: Record<LlmSourcesTab, number> = { logins: 0, keys: keys.count, endpoints: hubCount };
  const tabLabels: Record<LlmSourcesTab, string> = {
    logins: t`Logins`,
    keys: t`API keys`,
    endpoints: t`LLM Endpoints`,
  };

  const onSelect = useCallback(
    async (harness: string, source: LLMSource) => {
      try {
        // A device row must be PROVEN before it is chosen, and this is not belt-and-braces —
        // without it, Use on a device login is a no-op on exactly the box that needs it.
        //
        // An unprobed login is `rank=_RANK_DEVICE_UNPROVEN (30), auto=False` whenever a wallet
        // is available, and the hub endpoint is `rank=20, auto=True`; `pick_llm_candidate`
        // takes the first eligible AND auto, so the hub wins. Choosing the device row then
        // writes `auth_mode='device'` — which `_preferred` reads as "NO preference stated",
        // because `device` is the field's default and there is no way to say "device,
        // explicitly". So the pick evaporates and the ladder runs again, hub first. Reported
        // exactly that way: clicked Use, opened a new terminal, still on the hub budget.
        //
        // Probing is the honest fix rather than inventing a third preference state: a login
        // that answers `logged_in` becomes `_RANK_DEVICE (0)` and wins the ladder on its own
        // merits, which is what "use my OAuth" should mean. And a login that answers
        // `logged_out` — the case where the user had signed out of the CLI outside Flowpad,
        // while this page still offered Use — opens the sign-in the row could not.
        if (endpointFor(source)?.kind === LLMFundingKind.Device) {
          const proof = await llmSourcesService.testSource({ kind: 'device', harness });
          if (!proof.ok) {
            notify.warning({
              title: t`${source.name} is not signed in`,
              message: proof.message || t`Sign in first, then this source can fund a run.`,
              durationMs: 5000,
            });
            openHarnessSignIn(harness);
            return;
          }
        }
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
    [select, t, endpointFor],
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

      {/* Three tabs, one table look: the assistants' logins, this machine's keys, the hub's endpoints. */}
      <Tabs value={tab} onValueChange={(v) => openLlmSources(navigation, v)}>
        <TabsList data-testid="llm-sources-tabs">
          {LLM_SOURCES_TABS.map((k) => (
            <TabsTrigger key={k} value={k} data-testid={`llm-sources-tab-${k}`}>
              {counts[k] ? `${tabLabels[k]} (${counts[k]})` : tabLabels[k]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === 'logins' && !focused && (
        <LoginsTable status={status} record={record} onOpen={(worker) => openLlmSources(navigation, `logins/${worker}`)} />
      )}
      {tab !== 'logins' && <LlmEndpointsView key={tab} pointer={rest} embed={embed} source={tab === 'keys' ? 'local' : 'hub'} />}

      {focused && (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => openLlmSources(navigation, 'logins')} data-testid="llm-sources-back">
            <ArrowLeft className="me-1 h-4 w-4" />
            <Trans>All assistants</Trans>
          </Button>
          <h2 className="text-base font-semibold">{labelForWorker(workerOf(focused))}</h2>
          <span className="text-sm text-muted-foreground">
            {resolvedLabel(status, focused, t`nothing eligible`)}
          </span>
        </div>
      )}

      {focused && status.decision && <DecisionApiRow decision={status.decision} />}

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
                      testSource={testSource}
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
