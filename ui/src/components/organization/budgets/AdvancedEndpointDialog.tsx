/**
 * Everything about a budget that the budgets page deliberately does NOT show.
 *
 * The page answers one question — who may spend how much, and how much is left — with four
 * controls per row: the name, the total, the enable switch and the allowed models. The endpoint
 * behind that row has around twenty more knobs (per-window token and cost ceilings, a request
 * rate, temperature and top-p caps, path and beta allow-lists, alias and model maps). They are
 * real and occasionally needed, and putting them on the row would bury the four that matter.
 *
 * So they live here, behind one "Advanced" button per org, team and person. Nothing in this dialog
 * is new: it is `FiltersEditor` and `LimitsEditor` — the SAME two components the expert
 * `/dock/hub/llm-endpoints` dialog is built from — over the same entity, saved through the same
 * `dataManager.save`. A second implementation of twenty fields is exactly the thing that drifts.
 *
 * **What it omits, and why.** `cost_usd_total` and `models_allow` are the two fields the row
 * already edits. Showing them here as well would offer the same value in two shapes, saved by two
 * paths, with nothing to tell a reader which one wins. The row keeps them; this dialog hides them.
 *
 * **A root shows its provider and base URL read-only.** The hub refuses to change either once an
 * endpoint exists (`buildEntityJson` omits both when editing), so an editable field would be a
 * form that lies. A chain has neither, and shows what it draws from instead.
 *
 * **`readOnly` makes it a report instead of a form.** Every field renders disabled and Save is
 * replaced by Close. That is the state an ORGANISATION's row is in for an admin: the per-window
 * ceilings and rate caps in here bound what the organization may spend, so they belong with its
 * total — the owner's answer — rather than with dividing the money. Read-only rather than hidden,
 * because an admin who cannot see the ceilings has no way to understand a refusal coming from one.
 *
 * **`filters` is a whole-object write, `limits` is a merge.** The hub PUTs filters wholesale, so
 * this sends the complete object rebuilt from the form — which is why the form is seeded from the
 * live entity and not from defaults. Getting that backwards silently resets every filter the
 * dialog did not display.
 */
import { TypeId, dataManager } from '@sdk';
import { Loader2, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { FiltersEditor } from '@src/components/llm-endpoints/FiltersEditor';
import { LimitsEditor } from '@src/components/llm-endpoints/LimitsEditor';
import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { providerSpec } from '@src/components/llm-endpoints/endpoint-catalog';
import {
  filtersToForm,
  formToFilters,
  formToLimits,
  limitsToForm,
  LIMIT_KEYS,
  NUMERIC_FILTER_KEYS,
  badNonNegative,
  type FiltersForm,
  type LimitsForm,
} from '@src/components/llm-endpoints/filters-limits-forms';
import { useLlmEndpoint } from '@src/components/llm-endpoints/use-llm-endpoints';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Label } from '@src/components/ui/label';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { useInvalidateBudgets } from './use-budgets';

/** The two the budgets row owns. Kept as one named constant so the reason lives in one place. */
const OMITTED_LIMITS = ['cost_usd_total'] as const;

export interface AdvancedEndpointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A typeid or a bare uuid — normalized before every hub call. */
  endpointId: string;
  /** What this budget belongs to, for the dialog's title. */
  scopeLabel: string;
  /** Show the settings without offering to change them. */
  readOnly?: boolean;
}

export function AdvancedEndpointDialog({
  open,
  onOpenChange,
  endpointId,
  scopeLabel,
  readOnly = false,
}: AdvancedEndpointDialogProps) {
  const { t } = useLingui();
  const id = endpointIdFromTypeId(endpointId);
  const endpoint = useLlmEndpoint(open ? id : undefined);
  const invalidate = useInvalidateBudgets();
  const [filters, setFilters] = useState<FiltersForm | null>(null);
  const [limits, setLimits] = useState<LimitsForm | null>(null);
  const [saving, setSaving] = useState(false);

  // Seeded from the LIVE entity, once it arrives and once per opening. Re-seeding on every render
  // would throw away what is being typed; seeding from defaults would make the whole-object
  // `filters` write reset the fields this dialog does not show.
  useEffect(() => {
    if (!open) {
      setFilters(null);
      setLimits(null);
      return;
    }
    if (!endpoint || filters !== null) return;
    setFilters(filtersToForm(endpoint.filters));
    setLimits(limitsToForm(endpoint.limits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, endpoint?.id]);

  const problems =
    filters && limits
      ? [
          ...badNonNegative(filters, NUMERIC_FILTER_KEYS).map(() => t`Filter ceilings must be non-negative numbers.`),
          ...badNonNegative(limits, LIMIT_KEYS).map(() => t`Limits must be non-negative numbers.`),
        ]
      : [];

  const save = async () => {
    if (readOnly || !endpoint || !filters || !limits || problems.length > 0) return;
    setSaving(true);
    try {
      await dataManager.save(new TypeId(endpoint.typeId.toString()), [], {
        filters: formToFilters(filters),
        limits: formToLimits(limits),
      } as never);
      await invalidate();
      notify.success({ title: t`Advanced settings saved`, id: 'advanced-endpoint' });
      onOpenChange(false);
    } catch (e) {
      notify.error({
        title: t`Could not save the advanced settings`,
        message: errorMessage(e, ''),
        id: 'advanced-endpoint',
      });
    } finally {
      setSaving(false);
    }
  };

  const spec = providerSpec(endpoint?.provider);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl" data-testid="advanced-endpoint-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Advanced settings — {scopeLabel}</Trans>
          </DialogTitle>
          <DialogDescription>
            {readOnly ? (
              <Trans>
                Everything this budget is tuned with beyond its total and its allowed models. These are set by the
                organization's owner.
              </Trans>
            ) : (
              <Trans>
                Everything this budget can be tuned with beyond its total and its allowed models. Leave a field empty
                for no limit.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        {!endpoint || !filters || !limits ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <Trans>Loading…</Trans>
          </div>
        ) : (
          <div className="space-y-5">
            {spec && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>
                    <Trans>Provider</Trans>
                  </Label>
                  <p className="text-sm text-muted-foreground" data-testid="advanced-provider">
                    {t(spec.label)}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label>
                    <Trans>Base URL</Trans>
                  </Label>
                  {/* Read-only on purpose: the hub refuses to change it once the endpoint exists. */}
                  <p className="truncate text-sm text-muted-foreground" data-testid="advanced-base-url">
                    {endpoint.base_url || spec.defaultBaseUrl}
                  </p>
                </div>
              </div>
            )}

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Trans>Limits</Trans>
              </h3>
              <LimitsEditor value={limits} onChange={setLimits} disabled={saving || readOnly} omit={OMITTED_LIMITS} />
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Trans>Filters</Trans>
              </h3>
              <FiltersEditor value={filters} onChange={setFilters} disabled={saving || readOnly} omitModelsAllow />
            </section>

            {problems.length > 0 && (
              <p className="text-xs text-destructive" data-testid="advanced-problems">
                {problems[0]}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
          </Button>
          {!readOnly && (
            <Button
              onClick={() => void save()}
              disabled={saving || !endpoint || !filters || problems.length > 0}
              data-testid="advanced-save"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trans>Save</Trans>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The button that opens it. One component for all three rows, so the label, glyph and behaviour
 * cannot drift between org, team and person.
 *
 * `SlidersHorizontal` — tuning knobs — and not a gear: `Wallet` already means "budget settings" on
 * the org header, and `Zap` is `TestEndpointButton`'s. A page that gives one shape two meanings is
 * how a reader stops trusting any of them.
 *
 * `iconOnly` is for the people table, where this shares a cell with Edit and Delete and a word
 * would not fit. The label then survives as the accessible name and the tooltip — never dropped.
 */
export function AdvancedButton({
  endpointId,
  scopeLabel,
  testId,
  iconOnly,
  readOnly,
}: {
  endpointId: string;
  scopeLabel: string;
  testId: string;
  iconOnly?: boolean;
  /** Open the dialog as a report. The BUTTON still shows — see the dialog's `readOnly` note. */
  readOnly: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size={iconOnly ? 'icon' : 'sm'}
        variant="ghost"
        className={iconOnly ? 'h-6 w-6 shrink-0 text-muted-foreground' : 'gap-1 text-muted-foreground'}
        aria-label={t`Advanced`}
        title={
          readOnly
            ? t`Advanced: per-window limits, rate caps and filters (view only)`
            : t`Advanced: per-window limits, rate caps and filters`
        }
        data-testid={testId}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {!iconOnly && <Trans>Advanced</Trans>}
      </Button>
      {open && (
        <AdvancedEndpointDialog
          open
          onOpenChange={setOpen}
          endpointId={endpointId}
          scopeLabel={scopeLabel}
          readOnly={readOnly}
        />
      )}
    </>
  );
}
