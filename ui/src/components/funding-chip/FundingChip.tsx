import { Check, ChevronRight, Loader2 } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';

import {
  capabilityManager,
  CapabilityKinds,
  HARNESS_CAPABILITY_KINDS,
  LLMSourceOrigin,
  sameLlmSource,
  selectKindFor,
  type LLMFundingStatus,
  type LLMSource,
} from '@sdk';

import { cn } from '@src/lib/utils';
import { errorMessage } from '@src/lib/error-message';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { providerMetaFor } from '@src/tabs/provider-meta';
import { useDefaultWorkerType } from '@src/contexts/HarnessCapabilitiesContext';
import { HARNESS_CAPABILITY_BY_WORKER } from '@src/components/workers/worker-types';
import { MENU_ITEM_CLASS } from '@src/components/workers/WorkerToolbar';
import { dotFor, glyphForFundingKind, isScopePinned, scopeBadgeFor } from '@src/components/llm-sources/llm-source-visuals';
import { openLlmSources } from '@src/components/llm-sources/llm-sources-pointer';
import {
  endpointOf,
  labelForWorker,
  useLlmSources,
  useSelectSource,
  workerOf,
} from '@src/components/llm-sources/use-llm-sources';
import { visibleSources } from '@src/components/llm-sources/visible-sources';

/**
 * Who is paying for the next agent run, in two glyphs — the default harness, and the KIND of
 * credential funding it.
 *
 * It exists because that answer was unreachable. A box can sit pinned to a stored OpenRouter
 * key while a paid vendor subscription is signed in and idle, and every process silently
 * spawns on the wrong credential; nothing in the chrome said so, and the one screen that knew
 * was two clicks inside the version popover. Two glyphs in the footer is the smallest thing
 * that makes a wrong answer visible at rest.
 *
 * **Everything shown is the resolver's own answer.** The kind comes from the endpoint that
 * `status.resolved` names, never re-derived from `Capability.auth_mode` — see
 * `llm-source-visuals`. The rows are the offer list in the backend's own rank order, and every
 * refusal sentence is rendered verbatim.
 */
export function FundingChip() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const { navigation } = useDockNavigation();
  const { status, isLoading } = useLlmSources();

  const worker = useDefaultWorkerType();
  const kind = HARNESS_CAPABILITY_BY_WORKER[worker];
  const harnessMeta = providerMetaFor(worker);
  const harnessLabel = labelForWorker(workerOf(kind));

  // Two writes, one idiom. `useMutation` carries the pending flag, the in-flight variables
  // (which harness is switching) and the failure, so neither write needs hand-held state —
  // and `mutate` never rejects, which matters because a refusal here is EXPECTED, not
  // exceptional: picking a hub endpoint on a box with no hub login answers 409 by design.
  const select = useSelectSource();
  const switchHarness = useMutation({
    mutationFn: (harnessKind: string) => capabilityManager.setReferenceKind(CapabilityKinds.Harness, harnessKind),
  });
  const busy = select.isPending || switchHarness.isPending;
  // `errorMessage`, not `err.message`: an AxiosError is an Error whose message is the useless
  // "Request failed with status code 409", carrying the backend's actual sentence at
  // `response.data`. Reading `.message` would put the status line in front of the user on the
  // one refusal this menu is designed for.
  const failure = switchHarness.error ?? select.error;

  // Two different nulls, and collapsing them made the chip pop into the footer seconds after
  // everything else and shove the version chip sideways:
  //
  //  * still loading — a real box that has not answered YET (also every project switch, which
  //    is a fresh cache key with no data). The chip holds its place with the harness mark it
  //    already knows and a muted placeholder where the funding glyph goes. Not a guess: it
  //    says "not told yet", which is exactly true.
  //  * nothing to ask — hub mode, where the action does not exist, or a failed read. Then
  //    there is genuinely no chip to show.
  //
  // The harness mark is safe to draw in both: it comes from the capability context, not from
  // the funding status, and is available on the first paint.
  if (isLoading) {
    return (
      <span
        className="flex items-center gap-1 px-1.5 text-[10px] text-muted-foreground"
        title={t`Checking what funds ${harnessLabel}…`}
        data-testid="funding-chip-pending"
      >
        <span className="h-3.5 w-3.5 rounded-full bg-muted-foreground/20" />
        <harnessMeta.Icon className={cn('h-3.5 w-3.5 opacity-40', harnessMeta.iconClassName)} />
      </span>
    );
  }
  if (!status) return null;

  const resolved = status.resolved?.[kind] ?? null;
  const blocked = status.blocked?.[kind] ?? '';
  const glyph = glyphForFundingKind(endpointOf(status, resolved ?? undefined)?.kind);
  const pinned = isScopePinned(resolved?.origin);

  const choose = (source: LLMSource) => {
    const endpoint = endpointOf(status, source);
    if (!endpoint) return;
    select.mutate({
      harness: kind,
      source: {
        kind: selectKindFor(endpoint.kind),
        provider: endpoint.provider,
        endpoint_typeid: source.endpoint_typeid,
      },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={`${harnessLabel} · ${blocked || t(glyph.label)}`}
          aria-label={t`Agent funding`}
          data-testid="funding-chip-trigger"
        >
          <glyph.Icon className={cn('h-3.5 w-3.5', glyph.className)} />
          <harnessMeta.Icon className={cn('h-3.5 w-3.5', harnessMeta.iconClassName)} />
        </button>
      </PopoverTrigger>

      {/* Radix mounts this only while the popover is open, so the row work below costs
          nothing on the footer renders where it is shut — which is nearly all of them. */}
      <PopoverContent side="top" align="end" className="w-80 p-0" data-testid="funding-chip-popover">
        <section className="border-b px-3 py-2">
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Trans>Default assistant</Trans>
          </h4>
          <div className="grid grid-cols-2 gap-1">
            {HARNESS_CAPABILITY_KINDS.map((harnessKind) => {
              const w = workerOf(harnessKind);
              const meta = providerMetaFor(w);
              const active = harnessKind === kind;
              const starting = switchHarness.isPending && switchHarness.variables === harnessKind;
              return (
                <button
                  key={harnessKind}
                  type="button"
                  className={cn(MENU_ITEM_CLASS, 'text-xs', active ? 'text-foreground' : 'text-muted-foreground')}
                  disabled={busy}
                  onClick={() => switchHarness.mutate(harnessKind)}
                  data-testid={`funding-chip-harness-${w}`}
                >
                  {starting ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : (
                    <meta.Icon className={cn('h-3.5 w-3.5 shrink-0', meta.iconClassName)} />
                  )}
                  <span className="truncate">{labelForWorker(w)}</span>
                  {active && <Check className="ms-auto h-3 w-3 shrink-0" />}
                </button>
              );
            })}
          </div>
        </section>

        <section className="px-3 py-2">
          {/* The harness is named IN the heading, and its mark repeated, because the two
              sections are two different questions about the same subject and the checkmarks
              look alike. Without it the funding rows read as a second, unrelated choice. */}
          <h4 className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Trans>Funding for</Trans>
            <harnessMeta.Icon className={cn('h-3 w-3 shrink-0', harnessMeta.iconClassName)} />
            <span className="text-foreground">{harnessLabel}</span>
          </h4>
          {/* The backend owns this sentence — it is the only place a stuck harness explains
              itself, and rewriting it here would be a second author for the same fact. */}
          {blocked && <p className="mb-1.5 text-[11px] text-amber-500">{blocked}</p>}
          <ul className="space-y-0.5">
            {visibleSources(status, kind).map((source) => (
              <SourceRow
                key={source.endpoint_typeid}
                status={status}
                source={source}
                inUse={!!resolved && sameLlmSource(source, resolved)}
                originBadge={resolved?.origin}
                // A pin from a project or a process is not the user's to overrule, so the rows
                // that cannot win are not offered. The constraint gets said once, above, in the
                // backend's words, rather than repeated per row.
                disabled={busy || (pinned && !(!!resolved && sameLlmSource(source, resolved))) || !source.eligible}
                onChoose={choose}
              />
            ))}
          </ul>
        </section>

        {/* The write's own refusal, next to the rows that cause it. Without this a 409 is
            invisible and the menu reads as "nothing happened". */}
        {failure && (
          <p className="border-t px-3 py-1.5 text-[11px] text-amber-500" data-testid="funding-chip-error">
            {errorMessage(failure, t`That change could not be applied.`)}
          </p>
        )}
        <div className="flex items-center gap-2 border-t px-3 py-1.5">
          <button
            type="button"
            // Enabled only when there IS a pin of the user's to clear. `select` with the device
            // kind writes `auth_mode="device" / api_provider=null`, which the resolver reads as
            // NO preference — so with nothing pinned this button would be a no-op dressed as an
            // action, and with a project pin it cannot win at all.
            disabled={busy || pinned || resolved?.origin !== LLMSourceOrigin.User}
            onClick={() => select.mutate({ harness: kind, source: { kind: 'device' } })}
            className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            data-testid="funding-chip-automatic"
          >
            <Trans>Automatic</Trans>
          </button>
          {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openLlmSources(navigation, workerOf(kind));
            }}
            className="ms-auto flex items-center gap-0.5 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            data-testid="funding-chip-open-sources"
          >
            <Trans>LLM sources</Trans>
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One funding source, as a pickable row: the authority dot, the kind glyph, the name, and
 *  whatever the backend said about it — verbatim. */
function SourceRow({
  status,
  source,
  inUse,
  originBadge,
  disabled,
  onChoose,
}: {
  status: LLMFundingStatus;
  source: LLMSource;
  inUse: boolean;
  originBadge: string | undefined;
  disabled: boolean;
  onChoose: (source: LLMSource) => void;
}) {
  const { t } = useLingui();
  const endpoint = endpointOf(status, source);
  const glyph = glyphForFundingKind(endpoint?.kind);
  const badge = inUse ? scopeBadgeFor(originBadge) : null;
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChoose(source)}
        className={cn(MENU_ITEM_CLASS, 'items-start disabled:pointer-events-none disabled:opacity-50')}
        data-testid={`funding-chip-source-${endpoint?.kind ?? 'unknown'}${endpoint?.provider ? `-${endpoint.provider}` : ''}`}
      >
        <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', dotFor(source))} />
        <glyph.Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground', glyph.className)} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs text-foreground">{source.name}</span>
            {inUse && <Check className="h-3 w-3 shrink-0 text-emerald-500" />}
            {badge && (
              <span className="shrink-0 rounded-sm bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                {t(badge)}
              </span>
            )}
          </span>
          {(source.reason || source.detail) && (
            <span className="block truncate text-[10px] text-muted-foreground">
              {source.reason || source.detail}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
