/**
 * LLM sources — what funds each assistant on this machine, and why.
 *
 * URL: `/dock/llm-sources[/<section>/<key>]`. A DESK page, not a hub one: a device token, a
 * stored key and the endpoint *binding* are all box facts, and the box action that produces them
 * 404s on the hub. The one hub-native part (an endpoint's chain, limits and usage) already has a
 * hub page, which the endpoint rows link out to.
 *
 * The list is the explanation. Every row renders the backend's own `reason` verbatim — this
 * screen never authors ineligibility text, because a second author drifts from the resolver and
 * then the picker and the spawn disagree.
 */
import { LlmSourcesSection, LLMSourceKind, type LLMSource } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertCircle, ArrowUpRight, Check, KeyRound, Waypoints } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import { openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import { openLlmSources, parseLlmSourcesPointer, pointerForSource } from './llm-sources-pointer';
import { harnessKinds, useLlmSources, useSelectSource, workerOf } from './use-llm-sources';

const FRIENDLY: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  opencode: 'OpenCode',
};

const KIND_LABEL: Record<string, string> = {
  [LLMSourceKind.Device]: 'Device logins',
  [LLMSourceKind.ApiKey]: 'LLM keys',
  [LLMSourceKind.Endpoint]: 'Hub endpoints',
};

/** How much the eligibility answer is worth. A probed device login is evidence; an endpoint we
 *  merely believe is reachable is not the same claim, and flattening them would let a caller
 *  treat an assumption as a fact. */
const AUTHORITY_DOT: Record<string, string> = {
  proven: 'bg-emerald-400',
  cached: 'bg-emerald-400/50',
  presumed: 'bg-amber-400/70',
};

function SourceRow({
  source,
  harness,
  onSelect,
  busy,
}: {
  source: LLMSource;
  harness: string;
  onSelect: (s: LLMSource) => void;
  busy: boolean;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const worker = workerOf(harness);
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
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
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
      <Button
        size="sm"
        variant={source.auto ? 'secondary' : 'outline'}
        disabled={!source.eligible || source.auto || busy}
        onClick={() => onSelect(source)}
        data-testid={`llm-source-use-${worker}-${source.kind}`}
      >
        {source.auto ? <Trans>Using</Trans> : <Trans>Use</Trans>}
      </Button>
    </li>
  );
}

export function LlmSourcesView({ pointer }: { pointer?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { status, isLoading, error } = useLlmSources();
  const select = useSelectSource();
  const { section, key } = parseLlmSourcesPointer(pointer);

  const kinds = useMemo(() => harnessKinds(status), [status]);
  // The pointer selects a SOURCE; a harness filter is a view concern, so the first harness is the
  // default focus and the strip switches it without forking a tab.
  const focused = section === LlmSourcesSection.Device && key ? `harness.${key}.cli` : kinds[0];

  const onSelect = useCallback(
    async (harness: string, source: LLMSource) => {
      try {
        await select.mutateAsync({
          harness,
          source: { kind: source.kind, provider: source.provider, endpoint_typeid: source.endpoint_typeid },
        });
        notify.success({ title: t`Now using ${source.name}`, durationMs: 2500 });
      } catch (e) {
        notify.error({ title: t`Could not switch source`, message: errorMessage(e, '') });
      }
    },
    [select, t],
  );

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">{t`Loading…`}</div>;
  if (error || !status) {
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
          const worker = workerOf(kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => openLlmSources(navigation, LlmSourcesSection.Device, worker)}
              className={`rounded-lg border px-3 py-2 text-left text-xs ${
                focused === kind ? 'border-primary/60 bg-primary/5' : 'border-border/60'
              }`}
              data-testid={`llm-sources-chip-${worker}`}
            >
              <div className="font-medium">{FRIENDLY[worker] ?? worker}</div>
              <div className="text-muted-foreground">
                {pick ? `→ ${pick.name}` : t`nothing eligible`}
              </div>
            </button>
          );
        })}
      </section>

      {focused && (
        <section className="flex flex-col gap-3" data-testid="llm-sources-list">
          {[LLMSourceKind.Device, LLMSourceKind.ApiKey, LLMSourceKind.Endpoint].map((kind) => {
            const rows = (status.sources[focused] ?? []).filter((s) => s.kind === kind);
            if (!rows.length) return null;
            return (
              <div key={kind}>
                <h2 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {kind === LLMSourceKind.Endpoint ? <Waypoints className="h-3 w-3" /> : <KeyRound className="h-3 w-3" />}
                  {KIND_LABEL[kind]}
                </h2>
                <ul className="flex flex-col gap-1.5">
                  {rows.map((source) => (
                    <SourceRow
                      key={pointerForSource(source) || `${source.kind}:${focused}`}
                      source={source}
                      harness={focused}
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
