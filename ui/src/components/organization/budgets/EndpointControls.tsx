/**
 * The three controls the expert LLM Endpoints screen already offers per row — test, enable/
 * disable, and which models are allowed — brought onto the org/team/person budget rows so nobody
 * has to leave this page to reach them.
 *
 * All three read and write the SAME entity through the SAME hooks that screen already uses
 * (`useLlmEndpoint`, `TestEndpointButton`, `dataManager.save`) — nothing new on the hub, and no
 * second implementation to drift from the first.
 */
import { TypeId, dataManager, type LLMEndpointFilters } from '@sdk';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { TestEndpointButton } from '@src/components/llm-endpoints/TestEndpointButton';
import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { useLlmEndpoint } from '@src/components/llm-endpoints/use-llm-endpoints';
import { Switch } from '@src/components/ui/switch';
import { notify } from '@src/notifications';

import { useInvalidateBudgets } from './use-budgets';

/**
 * What a budget row allows when nobody has narrowed it: the cheapest tier, and ONLY that.
 *
 * A budget row should default to the cheap model — that is the whole point of a wallet with a $1
 * cap on it. What made this dangerous before was not the narrowness but the missing half: a worker
 * asks for a TIER, `CLAUDE_API_AUTH_SPEC.tier_models` maps sm/md/lg onto three different slugs, and
 * a machine configured for `md` therefore asked for sonnet and was REFUSED by a haiku-only list —
 * with no way for that person to fix it, since the tier lives in their own CLI config. It hid well,
 * too: `test` probes the cheapest ALLOWED model, so the row showed a green tick while real traffic
 * bounced.
 *
 * `aliasesForPinnedModel` is the missing half. Pinning now also REDIRECTS the other tiers onto the
 * pinned slug, so a narrow wallet serves every caller instead of refusing most of them. Cheap and
 * working, rather than cheap and broken.
 */
export const DEFAULT_MODELS = ['anthropic/claude-haiku-4.5'];

/** What each level of the hierarchy starts with when its list is empty. */
export type BudgetScope = 'org' | 'team' | 'person';

/**
 * Seeds by level, and the two blanks are the point.
 *
 * A child may only ever NARROW its parent (`filters.is_subset`, enforced on write with a 400), and
 * the check runs against the IMMEDIATE parent chain — not just the root. So every row that states a
 * model becomes a ceiling for everything beneath it. Pinning the team to one model would therefore
 * make "put this one person on sonnet" an illegal write, which is exactly the freedom this page
 * exists to give an admin.
 *
 * Hence: the ORG states the ceiling (what the payer is willing to fund at all), the TEAM states
 * nothing so it can never be the thing that blocks a person, and each PERSON gets the cheap default
 * — visible, and overridable one at a time without touching anyone else.
 */
export const SEED_BY_SCOPE: Record<BudgetScope, string[]> = {
  org: ['anthropic/claude-*', 'openai/gpt-*'],
  team: [],
  person: DEFAULT_MODELS,
};

/**
 * The family a slug belongs to, as a glob. `anthropic/claude-haiku-4.5` -> `anthropic/claude-*`.
 *
 * Deliberately a PATTERN and not a list of sibling slugs. An admin setting a budget knows which
 * model they are willing to fund; they do not know which slug each person's CLI is configured to
 * ask for, and enumerating every tier would restate a list that really lives in the worker specs
 * (`CLAUDE_API_AUTH_SPEC.tier_models`) -- a copy that silently stops matching the day a tier is
 * renamed there, taking the redirect with it. One pattern says the intent directly and keeps
 * working for models that did not exist when this was written.
 */
function familyGlobOf(slug: string): string | null {
  const match = /^([^/]+\/[a-z]+)-/.exec(slug);
  return match ? `${match[1]}-*` : null;
}

/**
 * The redirects that make an allowed list STICK, whatever each person's machine asks for.
 *
 * Allowing a model alone only ever produces a refusal: a worker asks for the tier IT is configured
 * for, and if that is not on the list the call dies with "model X not allowed by endpoint Y" --
 * which the person cannot fix, because the tier lives in their own CLI config, not on this page.
 * The hub resolves `filters.aliases` at the ENTRY endpoint BEFORE any filter check and rewrites the
 * request body (`llm_endpoint.py:1340`), so a machine set to sonnet transparently gets what the
 * wallet actually funds.
 *
 * Worked out PER FAMILY, because one list routinely spans several: `anthropic/claude-haiku-4.5` +
 * `openai/gpt-5-mini` is a wallet that serves Claude Code with the first and codex with the second.
 * A redirect never crosses families -- answering a request for one vendor with another's model
 * would be worse than refusing.
 *
 * Two things are deliberately left alone:
 *
 * * **A family already opened by a glob** (`anthropic/claude-*`) needs no redirect -- everything in
 *   it passes on its own -- and adding one would NARROW what the admin opened.
 * * **A model the admin explicitly listed** keeps working as itself. Where a family lists several,
 *   the family glob points at the first and each of the rest is given an identity entry, which wins
 *   because `resolve_alias` prefers an exact key over a glob. So an unlisted tier falls through to
 *   the first, while every listed one is still reachable — a choice the admin made stays a choice.
 */
export function aliasesForPinnedModel(models_allow: string[]): Record<string, string> {
  const byFamily = new Map<string, string[]>();
  for (const slug of models_allow) {
    if (slug.includes('*')) continue; // a glob allows a range; there is nothing to redirect to
    const family = familyGlobOf(slug);
    if (!family) continue;
    byFamily.set(family, [...(byFamily.get(family) ?? []), slug]);
  }

  const out: Record<string, string> = {};
  for (const [family, slugs] of byFamily) {
    if (models_allow.includes(family)) continue; // the family is open by glob already
    out[family] = slugs[0];
    for (const also of slugs.slice(1)) out[also] = also;
  }
  return out;
}

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
  const invalidate = useInvalidateBudgets();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // Guards the self-heal below to one attempt per mount — once it lands, `endpoint` itself carries
  // a non-empty list and the condition stops being true, but a save in flight must not double-fire
  // on a re-render before that round-trip completes.
  const seeding = useRef(false);

  const models = endpoint?.filters.models_allow ?? [];
  // A pinned row whose redirect is missing or stale. Every row pinned BEFORE aliasing existed is in
  // exactly this state: the right `models_allow`, no `aliases`, and no way for anyone to fix it by
  // hand — re-typing the same model is a no-op at `commit`, and the empty-list seed below never
  // fires on a row that already has a model. Without this they would refuse every `md`-tier caller
  // forever. Comparing the whole map (not just its presence) also repairs a row pinned to a slug
  // whose sibling tiers have since changed.
  const wantedAliases = aliasesForPinnedModel(models);
  const aliasesStale = !!endpoint && JSON.stringify(endpoint.filters.aliases ?? {}) !== JSON.stringify(wantedAliases);

  // "It should not remain empty": a wallet created before this control existed, or one whose
  // field was cleared and left, is put back onto the cheap default on its own — the same "a new
  // endpoint starts with the defaults as a real value" rule the expert dialog already applies at
  // CREATE time, just enforced here for every row instead of once at creation.
  useEffect(() => {
    // A reader never repairs the row. Somebody who may configure it will, the next time they open
    // the page, and until then a stale alias map is a wrong model — not a broken screen.
    if (!endpoint || seeding.current || !manage) return;
    const seed = SEED_BY_SCOPE[scope];
    // A level seeded with nothing (the team) is left blank on purpose — blank INHERITS, and that is
    // what keeps it from becoming a ceiling over the people beneath it.
    if (models.length === 0 && seed.length === 0) return;
    if (models.length > 0 && !aliasesStale) return;
    seeding.current = true;
    void saveModels(endpoint.typeId.toString(), endpoint.filters, models.length > 0 ? models : seed)
      .then(() => invalidate())
      .catch((e) => notify.error({ title: t`Could not set a default model`, message: String(e), id: 'models-allow' }))
      .finally(() => {
        seeding.current = false;
      });
    // `endpoint`/`invalidate`/`t` are stable enough for this effect's purpose; re-running on every
    // identity change would refire the seed check every render, which the `seeding` guard already
    // exists to prevent regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint?.id, models.length, aliasesStale, scope, manage]);

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
          placeholder={DEFAULT_MODELS.join(', ')}
          aria-label={t`Models allowed`}
          data-testid={`${testIdPrefix}-models-input`}
          className="min-w-40 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px]"
        />
      ) : (
        <button
          type="button"
          disabled={!manage}
          className="max-w-64 truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground enabled:hover:bg-muted"
          data-testid={`${testIdPrefix}-models`}
          title={manage ? t`Click to edit which models this budget may call` : t`Which models this budget may call`}
          onClick={startEdit}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : models.join(', ') || DEFAULT_MODELS.join(', ')}
        </button>
      )}

      <TestEndpointButton endpointId={id} />
    </div>
  );
}

async function saveModels(typeId: string, currentFilters: LLMEndpointFilters, models_allow: string[]): Promise<void> {
  // `filters` is a whole-object PUT on the hub, not a merge (only `limits`/`member_default_limits`
  // are) — sending just `{models_allow}` would silently reset every other filter (streaming,
  // max_tokens_ceiling, …) to its default. Rebuilding the full object from what the entity already
  // has, with only this one field changed, is what keeps the rest of the filters untouched.
  //
  // `aliases` is rewritten from the new list on every save, never merged into what was there. It is
  // derived state — "whatever this wallet is pinned to" — so widening a wallet back to the globs
  // must CLEAR the redirect, or a wallet that visibly allows everything would go on quietly forcing
  // the model it used to be pinned to.
  const aliases = aliasesForPinnedModel(models_allow);
  await dataManager.save(new TypeId(typeId), [], { filters: { ...currentFilters, models_allow, aliases } } as never);
}
