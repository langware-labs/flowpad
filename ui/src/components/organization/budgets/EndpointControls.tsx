/**
 * The three controls the expert LLM Endpoints screen already offers per row — test, enable/
 * disable, and which models are allowed — brought onto the org/team/person budget rows so nobody
 * has to leave this page to reach them.
 *
 * All three read and write the SAME entity through the SAME hooks that screen already uses
 * (`useLlmEndpoint`, `TestEndpointButton`, `dataManager.save`) — nothing new on the hub, and no
 * second implementation to drift from the first.
 */
import { TypeId, dataManager, llmEndpointsService, type LLMEndpointFilters, type LLMEndpointTestResult } from '@sdk';
import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { TestEndpointButton } from '@src/components/llm-endpoints/TestEndpointButton';
import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { TONE } from '@src/components/llm-endpoints/tone';
import { useLlmEndpoint, useLlmEndpoints, useLlmProviderSizes } from '@src/components/llm-endpoints/use-llm-endpoints';
import { Switch } from '@src/components/ui/switch';
import { notify } from '@src/notifications';

import {
  aliasesForPinnedModel,
  MODEL_FAMILY_PRESETS,
  presetEntries,
  reconcileAliases,
  sameAliases,
  SEED_BY_SCOPE,
  withModelEntries,
  type BudgetScope,
} from './budget-models';
import { useInvalidateBudgets } from './use-budgets';

export interface EndpointControlsProps {
  /** A typeid or bare uuid — normalized before every hub call, the way `MembersTable` documents. */
  endpointId: string;
  /** Which level of org -> team -> person this row is; decides what an empty list is seeded with. */
  scope: BudgetScope;
  testIdPrefix: string;
  /**
   * May the caller CHANGE this endpoint (the hub's `update` answer)? Required rather than
   * defaulted, because the wrong answer here is silent.
   *
   * It gates the self-heal below as well as the controls, and that half is not cosmetic: the seed
   * effect WRITES on mount, so a viewer who may only read would fire a doomed save and an error
   * toast every time the row rendered. An org admin looking at the organization's own row is
   * exactly that viewer.
   */
  manage: boolean;
}

export function EndpointControls({ endpointId, scope, testIdPrefix, manage }: EndpointControlsProps) {
  const { t } = useLingui();
  const id = endpointIdFromTypeId(endpointId);
  const endpoint = useLlmEndpoint(id);
  // The rows on this screen are ENTITIES, not budget rows, so the budgets invalidation alone does
  // not refresh them — and a team edit now moves the members' lists too (`_cascade_models`, hub).
  // Those writes are made BY THE HUB, so nothing tells this client about them: without an explicit
  // re-read, an admin narrows a team and every member below it goes on showing the old models.
  const { refetch: refetchEndpoints } = useLlmEndpoints();
  const invalidate = useInvalidateBudgets();
  // Only a row below the org writes sizes, so only those rows ask; the answer is cached once for all of them.
  const providerSizes = useLlmProviderSizes(scope === 'org' ? undefined : id);
  // The probe's own answer, mirrored out of the button so it can be drawn OVER the model list
  // instead of beside the icon. Rendered inline, the verdict wrapped the row's flex container onto
  // a second line and every row grew taller the moment somebody pressed test — on a table, that
  // shifts every row below it. An overlay is out of flow, so the row never moves.
  const [verdict, setVerdict] = useState<LLMEndpointTestResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // Guards the self-heal below to one attempt per mount — once it lands, `endpoint` itself carries
  // a non-empty list and the condition stops being true, but a save in flight must not double-fire
  // on a re-render before that round-trip completes.
  const seeding = useRef(false);

  const models = endpoint?.filters.models_allow ?? [];
  // The row shows ITS OWN list and nothing else: an empty list is shown empty. It used to print the models an
  // empty list inherits, which made a cleared row look as full as before the press.
  const shown = models;
  // A pinned row whose redirect is missing or stale. Every row pinned BEFORE aliasing existed is in
  // exactly this state: the right `models_allow`, no `aliases`, and no way for anyone to fix it by
  // hand — re-typing the same model is a no-op at `commit`, and the empty-list seed below never
  // fires on a row that already has a model. Without this they would refuse every `md`-tier caller
  // forever. Comparing the whole map (not just its presence) also repairs a row pinned to a slug
  // whose sibling tiers have since changed.
  const wantedAliases = reconcileAliases(endpoint?.filters.aliases ?? {}, models);
  const aliasesStale = !!endpoint && !sameAliases(endpoint.filters.aliases ?? {}, wantedAliases);

  // Repairs a STALE REDIRECT, and nothing else. It used to also seed an empty list, and that was
  // the bug: a wallet was restricted because somebody opened this screen, so a person nobody had
  // looked at inherited the org's whole ceiling — and the wallets the hub mints on first bootstrap
  // were never seen by this page at all. Choosing the initial list is now the hub's job
  // (`_seed_models`), which is on every creation path rather than on this one.
  //
  // What remains is not policy: a row with models but no aliases refuses every `md`-tier caller,
  // and nobody can fix it by hand (re-typing the same model is a no-op at `commit`). Deriving the
  // redirect from the list already on the row invents nothing and can never widen it.
  useEffect(() => {
    // A reader never repairs the row. Somebody who may configure it will, the next time they open
    // the page, and until then a stale alias map is a wrong model — not a broken screen.
    if (!endpoint || seeding.current || !manage) return;
    if (models.length === 0 || !aliasesStale) return;
    seeding.current = true;
    void saveModels(endpoint.typeId.toString(), endpoint.filters, models)
      .then(() => invalidate())
      .catch((e) =>
        notify.error({ title: t`Could not repair the model redirect`, message: String(e), id: 'models-allow' }),
      )
      .finally(() => {
        seeding.current = false;
      });
    // `endpoint`/`invalidate`/`t` are stable enough for this effect's purpose; re-running on every
    // identity change would refire the check every render, which the `seeding` guard already
    // exists to prevent regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint?.id, models.length, aliasesStale, manage]);

  if (!endpoint) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  }

  const startEdit = () => {
    setDraft(models.join(', '));
    setEditing(true);
  };

  const commit = async () => {
    const next = draft
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    setEditing(false);
    // Never let a commit clear the field — that would silently widen the wallet to every model
    // every source allows, which is the exact hole `MODELS_ALLOW_DEFAULT` exists to close.
    if (next.length === 0) return;
    if (next.length === models.length && next.every((m, i) => m === models[i])) return;
    setSaving(true);
    try {
      await saveModels(endpoint.typeId.toString(), endpoint.filters, next);
      await invalidate();
      await refetchEndpoints();
      // Say what the pin actually DOES. An admin pinning a wallet to one model has no way to know
      // that the other tiers are being redirected onto it rather than refused, and the difference
      // is the whole question of whether the person can still send anything.
      const redirected = Object.keys(aliasesForPinnedModel(next));
      if (redirected.length > 0) {
        notify.success({
          title: t`Model pinned to ${next[0]}`,
          message: t`Requests for ${redirected.join(' and ')} will be served as ${next[0]} — nobody has to change their own settings.`,
          id: 'models-allow',
        });
      }
    } catch (e) {
      notify.error({ title: t`Could not save the allowed models`, message: String(e), id: 'models-allow' });
    } finally {
      setSaving(false);
    }
  };

  // The one-press lists. `next` is the whole new list ([] clears it): a family press appends to the
  // row's OWN list, so pressing two of them chains the two.
  const applyModels = async (next: string[], { clearRedirects = false } = {}) => {
    setSaving(true);
    try {
      await saveModels(endpoint.typeId.toString(), endpoint.filters, next, clearRedirects);
      await invalidate();
      await refetchEndpoints();
    } catch (e) {
      notify.error({ title: t`Could not save the allowed models`, message: String(e), id: 'models-allow' });
    } finally {
      setSaving(false);
    }
  };

  // "All": every model the provider offers, written out as the list. Done in two writes because the
  // `models` action answers with the catalog narrowed by THIS chain's allow list, row included: clear
  // the row first, so what comes back is the whole catalog the budget above lets through, then write
  // exactly that. A redirect derived from a list this long would point every family at its first
  // member, so the row's redirects are cleared and none are derived.
  const applyAllModels = async () => {
    setSaving(true);
    try {
      await saveModels(endpoint.typeId.toString(), endpoint.filters, [], true);
      const offered = (await llmEndpointsService.listModels(id)).map((m) => m.id);
      await saveModels(
        endpoint.typeId.toString(),
        { ...endpoint.filters, models_allow: [], aliases: {} },
        offered,
        true,
      );
      await invalidate();
      await refetchEndpoints();
    } catch (e) {
      notify.error({ title: t`Could not save the allowed models`, message: String(e), id: 'models-allow' });
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (checked: boolean) => {
    try {
      await dataManager.save(endpoint.typeId, [], { enabled: checked } as never);
      await invalidate();
    } catch (e) {
      notify.error({ title: t`Could not change enabled state`, message: String(e), id: 'endpoint-enabled' });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <label className="flex items-center gap-1.5 text-muted-foreground" data-testid={`${testIdPrefix}-enabled`}>
        <Switch
          checked={endpoint.enabled}
          disabled={!manage}
          onCheckedChange={(v) => void toggleEnabled(v)}
          aria-label={endpoint.enabled ? t`Enabled` : t`Disabled`}
        />
        {endpoint.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
      </label>

      {editing && manage ? (
        <input
          autoFocus
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          placeholder={SEED_BY_SCOPE[scope].join(', ')}
          aria-label={t`Models allowed`}
          data-testid={`${testIdPrefix}-models-input`}
          className="min-w-40 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px]"
        />
      ) : (
        <span className="relative min-w-0">
          {/* Out of flow, anchored over the model list: a verdict must not resize the row. Sits
              ABOVE the text rather than on top of it, so the models stay readable while it shows —
              the two answer different questions and a reader usually wants both at once. */}
          {verdict && (
            <span
              className={`absolute bottom-full left-0 z-10 mb-0.5 flex max-w-64 items-baseline gap-1 truncate rounded border px-1.5 py-0.5 font-mono text-[11px] shadow-md ${
                verdict.ok ? TONE.emerald : TONE.destructive
              } bg-popover`}
              data-testid={`${testIdPrefix}-test-overlay`}
              title={
                verdict.ok
                  ? `${verdict.status} · ${verdict.model} · ${verdict.latency_ms}ms`
                  : `${verdict.status || ''} ${verdict.message}`.trim()
              }
            >
              {verdict.ok ? (
                <>
                  <Check className="h-3 w-3 shrink-0" />
                  {verdict.model && <span className="truncate">{verdict.model}</span>}
                  <span className="opacity-70">{verdict.latency_ms}ms</span>
                </>
              ) : (
                <>
                  <X className="h-3 w-3 shrink-0" />
                  <span className="truncate">{verdict.status || t`failed`}</span>
                </>
              )}
            </span>
          )}
          <button
            type="button"
            disabled={!manage}
            // Narrow enough that the test button stays on the row with it. The container wraps, so a
            // wide list did not overflow -- it pushed the probe onto a second line, where a control
            // people press constantly reads as belonging to the row below.
            className="min-h-5 min-w-8 max-w-48 truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground enabled:hover:bg-muted"
            data-testid={`${testIdPrefix}-models`}
            // Trimmed text always carries the whole of itself in the tooltip; the hint follows it.
            title={[shown.join(', '), manage ? t`Click to edit which models this budget may call` : '']
              .filter(Boolean)
              .join('\n')}
            onClick={startEdit}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : shown.join(', ')}
          </button>
        </span>
      )}

      {manage && (
        <span className="flex shrink-0 items-center gap-1" data-testid={`${testIdPrefix}-model-presets`}>
          <button
            type="button"
            disabled={saving}
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground enabled:hover:bg-muted disabled:opacity-50"
            data-testid={`${testIdPrefix}-models-clear`}
            title={t`Remove every model and every redirect from this list`}
            onClick={() => void applyModels([], { clearRedirects: true })}
          >
            <Trans>Clear</Trans>
          </button>
          <button
            type="button"
            disabled={saving}
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground enabled:hover:bg-muted disabled:opacity-50"
            data-testid={`${testIdPrefix}-models-all`}
            title={t`Puts everything that is available on OpenRouter`}
            onClick={() => void applyAllModels()}
          >
            <Trans>All</Trans>
          </button>
          {MODEL_FAMILY_PRESETS.map((preset) => {
            const entries = presetEntries(preset, scope, providerSizes.data);
            return (
              <button
                key={preset.key}
                type="button"
                disabled={saving || !entries || entries.every((entry) => models.includes(entry))}
                className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground enabled:hover:bg-muted disabled:opacity-50"
                data-testid={`${testIdPrefix}-models-add-${preset.key}`}
                title={entries ? t`Allow ${entries.join(', ')}` : t`No sizes are declared for ${preset.label}`}
                onClick={() => entries && void applyModels(withModelEntries(models, entries))}
              >
                {preset.label}
              </button>
            );
          })}
        </span>
      )}

      <span className="shrink-0">
        <TestEndpointButton endpointId={id} onVerdict={setVerdict} inlineVerdict={false} />
      </span>
    </div>
  );
}

async function saveModels(
  typeId: string,
  currentFilters: LLMEndpointFilters,
  models_allow: string[],
  clearRedirects = false,
): Promise<void> {
  // `filters` is a whole-object PUT on the hub, not a merge (only `limits`/`member_default_limits`
  // are) — sending just `{models_allow}` would silently reset every other filter (streaming,
  // max_tokens_ceiling, …) to its default. Rebuilding the full object from what the entity already
  // has, with only this one field changed, is what keeps the rest of the filters untouched.
  //
  // `aliases` is rebuilt from the new list on every save: it is derived state — "whatever this wallet
  // is pinned to" — so widening a wallet back to the globs must CLEAR the redirect, or a wallet that
  // visibly allows everything would go on quietly forcing the model it used to be pinned to. The one
  // thing carried over is what an admin wrote by hand across families (Claude -> Gemini), which the
  // derivation cannot produce and which still points at an allowed model.
  // `clearRedirects` is the "Clear" / "All" presses: they start the row over, so a hand-written redirect
  // goes too instead of being carried across.
  const aliases = clearRedirects ? {} : reconcileAliases(currentFilters.aliases ?? {}, models_allow);
  await dataManager.save(new TypeId(typeId), [], { filters: { ...currentFilters, models_allow, aliases } } as never);
}
