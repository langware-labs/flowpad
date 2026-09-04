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
 * What a budget row allows when nobody has narrowed it — the SAME glob pair the expert page offers
 * as `MODELS_ALLOW_DEFAULT`, and for the same reason.
 *
 * This used to seed one exact slug, `anthropic/claude-haiku-4.5`, on the theory that a budget row
 * should default to the cheap model. That silently broke every wallet it touched. A worker asks for
 * a TIER, and `CLAUDE_API_AUTH_SPEC.tier_models` maps those to three different slugs — `sm` haiku,
 * `md` sonnet, `lg` opus — with `md` the ordinary default. An allow-list holding only the `sm` slug
 * therefore refuses the very model a normal prompt asks for, so the person could not send anything.
 * The failure hid well: `test` probes the cheapest ALLOWED model, which was the one on the list, so
 * the row reported a green tick while real traffic was refused.
 *
 * Capping SPEND is what `limits.cost_usd_total` is for. Pinning the model list is a different knob,
 * and defaulting it to one tier is not a cheaper wallet — it is a broken one.
 */
export const DEFAULT_MODELS = ['anthropic/claude-*', 'openai/gpt-*'];

export interface EndpointControlsProps {
  /** A typeid or bare uuid — normalized before every hub call, the way `MembersTable` documents. */
  endpointId: string;
  testIdPrefix: string;
}

export function EndpointControls({ endpointId, testIdPrefix }: EndpointControlsProps) {
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

  // "It should not remain empty": a wallet created before this control existed, or one whose
  // field was cleared and left, is put back onto the cheap default on its own — the same "a new
  // endpoint starts with the defaults as a real value" rule the expert dialog already applies at
  // CREATE time, just enforced here for every row instead of once at creation.
  useEffect(() => {
    if (!endpoint || models.length > 0 || seeding.current) return;
    seeding.current = true;
    void saveModels(endpoint.typeId.toString(), endpoint.filters, DEFAULT_MODELS)
      .then(() => invalidate())
      .catch((e) => notify.error({ title: t`Could not set a default model`, message: String(e), id: 'models-allow' }))
      .finally(() => {
        seeding.current = false;
      });
    // `endpoint`/`invalidate`/`t` are stable enough for this effect's purpose; re-running on every
    // identity change would refire the seed check every render, which the `seeding` guard already
    // exists to prevent regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint?.id, models.length]);

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
          onCheckedChange={(v) => void toggleEnabled(v)}
          aria-label={endpoint.enabled ? t`Enabled` : t`Disabled`}
        />
        {endpoint.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
      </label>

      {editing ? (
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
          className="max-w-64 truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground hover:bg-muted"
          data-testid={`${testIdPrefix}-models`}
          title={t`Click to edit which models this budget may call`}
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
  await dataManager.save(new TypeId(typeId), [], { filters: { ...currentFilters, models_allow } } as never);
}
