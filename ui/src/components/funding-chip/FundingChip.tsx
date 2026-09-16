import { useLingui } from '@lingui/react/macro';

import { cn } from '@src/lib/utils';
import { providerMetaFor } from '@src/tabs/provider-meta';
import { useDefaultWorkerType } from '@src/contexts/HarnessCapabilitiesContext';
import { HARNESS_CAPABILITY_BY_WORKER } from '@src/components/workers/worker-types';
import { glyphForFundingKind } from '@src/components/llm-sources/llm-source-visuals';
import { openHarnessLoginModal } from '@src/components/harness-login/harness-login-store';
import { endpointOf, labelForWorker, useLlmSources, workerOf } from '@src/components/llm-sources/use-llm-sources';

/**
 * Who is paying for the next agent run, in two glyphs — the default harness, and the KIND of
 * credential funding it.
 *
 * It exists because that answer was unreachable. A box can sit pinned to a stored OpenRouter
 * key while a paid vendor subscription is signed in and idle, and every process silently
 * spawns on the wrong credential; nothing in the chrome said so. Two glyphs in the footer is
 * the smallest thing that makes a wrong answer visible at rest.
 *
 * **It reports; it no longer decides.** This used to open its own popover carrying a default-
 * assistant grid and a funding picker — a third place to answer "what pays for my LLM calls",
 * alongside the Assistants & keys dialog and the LLM sources page. Three surfaces meant three
 * vocabularies for one question, and they had already drifted: this one said "Automatic" for
 * the state the dialog calls a device login, and listed sources the dialog grouped differently.
 * Clicking now opens the ONE dialog, which `flow llm set auto` also opens. One picker, three
 * ways in.
 *
 * What is left here is the part nothing else does: saying the answer without being asked.
 *
 * **Everything shown is the resolver's own answer.** The kind comes from the endpoint that
 * `status.resolved` names, never re-derived from `Capability.auth_mode` — see
 * `llm-source-visuals`.
 */
export function FundingChip() {
  const { t } = useLingui();
  const { status, isLoading } = useLlmSources();

  const worker = useDefaultWorkerType();
  const kind = HARNESS_CAPABILITY_BY_WORKER[worker];
  const harnessMeta = providerMetaFor(worker);
  const harnessLabel = labelForWorker(workerOf(kind));

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

  return (
    <button
      type="button"
      onClick={() => openHarnessLoginModal()}
      className="flex items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      // The backend owns this sentence — it is the only place a stuck harness explains itself,
      // and rewriting it here would be a second author for the same fact.
      title={`${harnessLabel} · ${blocked || t(glyph.label)}`}
      aria-label={t`Agent funding`}
      data-testid="funding-chip-trigger"
    >
      <glyph.Icon className={cn('h-3.5 w-3.5', glyph.className)} />
      <harnessMeta.Icon className={cn('h-3.5 w-3.5', harnessMeta.iconClassName)} />
    </button>
  );
}
