/**
 * Add or edit a source. One form, because the fields are identical and a
 * separate editor would be the same code with a different verb on the button.
 *
 * What it deliberately does NOT write: `kind` and `channel`. `sync_source`
 * (flow_sdk/ingest/sync.py) writes both from the driver on the first poll, so a
 * value set here would look authoritative, be owned by nobody, and get silently
 * corrected later. For the agent transport the channel IS `config.connector`,
 * which the form does set — through the field that owns it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DataSource, type SourceStatus } from '@sdk';
import type { TypeId } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { lucideByName } from '@src/lib/lucide-by-name';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import {
  accountKeyFor,
  buildConfig,
  emptyDraft,
  pickedFrom,
  pickedIn,
  specFields,
  validateDraft,
  type SourceDraft,
} from './source-form';
import { ChoiceField } from './ChoiceField';
import { sourceIconName } from './source-icon';
import { DesktopTile, TILE_TIP_DELAY, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { useSourceSpecs } from './use-source-specs';
import { FieldType, type DataSourceChoice, type DataSourceSpec, type SpecConfigField } from '@sdk';

/**
 * The switch's boolean → a lifecycle status.
 *
 * Un-pausing does NOT mean "active": a Slack source that was paused mid-setup
 * must go back to needing its invite, not skip it. So it returns to `new` and
 * lets the backend re-resolve — the one place that knows which drivers verify.
 */
function statusFor(enabled: boolean, current: SourceStatus): SourceStatus {
  if (!enabled) return 'disabled';
  return current === 'disabled' ? 'new' : current;
}

/** Config value → the string its input shows. Arrays rejoin the way they split. */
function fieldValue(key: string, field: SpecConfigField, config: Record<string, unknown>): string {
  const raw = config?.[key];
  if (raw === undefined || raw === null) return '';
  // A choosable field's entries may be `{id, name}`. Joining those directly is how a
  // Slack source configured with named channels rendered as `[object Object]` — and then
  // SAVED that back over the real ids.
  //
  // IDs, not names, even though a name is friendlier: this string is only ever shown in
  // the TYPED fallback, and whatever sits there is what gets stored the moment someone
  // edits it. Showing "Marketing" in a box whose next keystroke saves "Marketing" as a
  // drive id is a silent corruption. The name belongs to the picker, which reads `picked`.
  if (field.choices) {
    const picked = pickedFrom(key, field, config);
    return picked.map((c) => c.id).join(field.type === FieldType.LINES ? '\n' : ', ');
  }
  if (Array.isArray(raw)) return raw.join(field.type === FieldType.LINES ? '\n' : ', ');
  // Only scalars round-trip through an input. A nested object in config means
  // the driver grew a shape this form does not model — show nothing rather than
  // "[object Object]", which would be saved back verbatim and corrupt it.
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

function draftFrom(source: DataSource, spec?: DataSourceSpec): SourceDraft {
  const fields: Record<string, string> = {};
  const picked: Record<string, DataSourceChoice[]> = {};
  for (const [key, field] of specFields(spec)) {
    fields[key] = fieldValue(key, field, source.config ?? {});
    if (field.choices) picked[key] = pickedFrom(key, field, source.config ?? {});
  }
  return {
    name: source.name,
    provider: source.provider,
    account_key: source.account_key,
    // The switch is "not paused", which is NOT "active": a source still in
    // `setup` is unpaused and deliberately not running. Mapping it back through
    // a boolean is why the toggle cannot resolve the lifecycle itself — see
    // `statusFor`.
    enabled: source.status !== 'disabled',
    poll_interval_seconds: source.poll_interval_seconds,
    window_days: source.window_days,
    fields,
    picked,
  };
}

export function DataSourceDialog({
  open,
  onOpenChange,
  editing,
  owner,
  only,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the form edits this source instead of creating one. */
  editing?: DataSource | null;
  /** Who the new source belongs to (a user or an agent). Omitted → the backend
   *  stamps the local user, so every existing caller is unchanged. */
  owner?: TypeId | null;
  /** Narrow the provider tiles — the channels bar offers only specs that `sends`. */
  only?: (spec: DataSourceSpec) => boolean;
}) {
  const { t } = useLingui();
  // Whatever is INSTALLED, not a hardcoded list: a source added as an asset
  // shows up here with no frontend release.
  const { specs: installed, specFor } = useSourceSpecs();
  const specs = only ? installed.filter(only) : installed;
  const [draft, setDraft] = useState<SourceDraft>(() => emptyDraft(''));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  // Seed the form once per opening, keyed on WHAT is being edited. `specs` /
  // `specFor` change identity on every live `DataSourceSpec` emission, and
  // depending on them re-seeded the draft mid-typing — discarding whatever had
  // been entered. The spec is read through a ref so the seed still sees the
  // current one without subscribing the effect to it.
  const seedRef = useRef({ specFor, specs });
  seedRef.current = { specFor, specs };
  useEffect(() => {
    if (!open) return;
    const { specFor: lookup, specs: available } = seedRef.current;
    setDraft(editing ? draftFrom(editing, lookup(editing.provider)) : emptyDraft(available[0]?.name ?? ''));
    setShowAdvanced(false);
  }, [open, editing]);

  const spec = specFor(draft.provider);
  const problems = useMemo(() => validateDraft(draft, spec), [draft, spec]);

  const setField = (key: string, value: string) =>
    // Typing into a choosable field drops its picks: the two inputs are never both
    // authoritative, and `buildConfig` prefers a pick — so a stale one would silently
    // beat what the person just typed.
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value }, picked: { ...d.picked, [key]: [] } }));

  const setPicked = (key: string, choices: DataSourceChoice[]) =>
    setDraft((d) => ({ ...d, picked: { ...d.picked, [key]: choices } }));

  const submit = async () => {
    if (problems.length) return;
    setBusy(true);
    try {
      const config = buildConfig(draft, spec);
      const account = accountKeyFor(draft, spec);
      if (editing) {
        const nextName = draft.name.trim();
        const nextStatus = statusFor(draft.enabled, editing.status);
        const changed =
          editing.name !== nextName ||
          editing.status !== nextStatus ||
          editing.account_key !== account ||
          JSON.stringify(editing.config ?? {}) !== JSON.stringify(config) ||
          editing.poll_interval_seconds !== draft.poll_interval_seconds ||
          editing.window_days !== draft.window_days;
        editing.name = nextName;
        editing.status = nextStatus;
        editing.account_key = account;
        editing.config = config;
        editing.poll_interval_seconds = draft.poll_interval_seconds;
        editing.window_days = draft.window_days;
        await editing.save();
        if (changed) editing.markEdit();
        notify.success({ title: t`Updated ${editing.name}` });
      } else {
        const source = new DataSource({
          name: draft.name.trim(),
          provider: draft.provider,
          account_key: account,
          config,
          // 'new' on purpose: the backend resolves it to `setup` or `active`
          // depending on whether the driver has a verification step, and only
          // it knows which drivers do.
          status: draft.enabled ? 'new' : 'disabled',
          poll_interval_seconds: draft.poll_interval_seconds,
          window_days: draft.window_days,
          owner: owner ? owner.toString() : null,
        });
        await source.save();
        notify.success({ title: t`Added ${source.name}` });
      }
      onOpenChange(false);
    } catch (e) {
      notify.error({ title: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Built once per render, not once per choosable field: `buildConfig` walks the whole
  // spec, so asking it per field rebuilt every other field's value too.
  const draftConfig = useMemo(() => buildConfig(draft, spec), [draft, spec]);

  const renderField = ([key, field]: [string, SpecConfigField]) => {
    const value = draft.fields[key] ?? '';
    const input =
      field.type === FieldType.LINES ? (
        <Textarea
          id={`ds-${key}`}
          rows={3}
          value={value}
          placeholder={field.placeholder || undefined}
          onChange={(e) => setField(key, e.target.value)}
        />
      ) : (
        <Input
          id={`ds-${key}`}
          type={field.type === FieldType.NUMBER ? 'number' : 'text'}
          value={value}
          placeholder={field.placeholder || undefined}
          onChange={(e) => setField(key, e.target.value)}
        />
      );
    return (
      <div key={key} className="space-y-1">
        <Label htmlFor={`ds-${key}`}>
          {field.label || key}
          {field.required && <span className="ms-1 text-destructive">*</span>}
        </Label>
        {/* A choosable field hands its own input over as the fallback, so the picker and
            the text box are one decision made in one place rather than two branches here
            that could both be true. */}
        {field.choices ? (
          <ChoiceField
            fieldKey={key}
            field={field}
            provider={draft.provider}
            config={draftConfig}
            picked={pickedIn(draft, key, field)}
            onPicked={(choices) => setPicked(key, choices)}
            fallback={input}
          />
        ) : (
          input
        )}
        {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t`Edit data source` : t`Add a data source`}</DialogTitle>
          <DialogDescription>
            <Trans>A source is one remote account or feed set. The poller syncs it on the heartbeat.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!editing && (
            <TileSection title={<Trans>Provider</Trans>}>
              {specs.map((p) => {
                // Through the one source→glyph rule, so the tile a person picks and the
                // card it becomes cannot disagree. No channel here: a provider is being
                // chosen, not one of a multi-channel transport's channels.
                const Glyph = lucideByName(sourceIconName(p, null));
                const label = p.title || p.name || '';
                return (
                  <Tooltip key={p.name} delayDuration={TILE_TIP_DELAY}>
                    <TooltipTrigger asChild>
                      <DesktopTile
                        data-testid={`provider-${p.name}`}
                        Icon={Glyph}
                        label={label}
                        onClick={() => setDraft(emptyDraft(p.name ?? ''))}
                        className={cn(
                          draft.provider === p.name &&
                            'border-primary bg-accent text-foreground ring-1 ring-primary',
                        )}
                      />
                    </TooltipTrigger>
                    {/* What the tile used to spell out underneath. A 10px line
                        of body copy per provider made the grid a wall of text
                        to read before you could pick anything; the sentence is
                        still one hover away, where it answers a question you
                        actually have. */}
                    <TooltipContent side="bottom" className="max-w-[16rem]">
                      <span className="font-medium">{label}</span>
                      {p.description && <span className="mt-0.5 block opacity-90">{p.description}</span>}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </TileSection>
          )}

          <div className="space-y-1">
            <Label htmlFor="ds-name">
              <Trans>Name</Trans>
              <span className="ms-1 text-destructive">*</span>
            </Label>
            <Input
              id="ds-name"
              value={draft.name}
              placeholder={spec?.title || undefined}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>

          {specFields(spec).filter(([, f]) => !f.advanced).map(renderField)}

          <div className="flex items-center justify-between rounded border p-2">
            <Label htmlFor="ds-enabled" className="text-sm">
              <Trans>Enabled</Trans>
            </Label>
            <Switch
              id="ds-enabled"
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            />
          </div>

          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? t`Hide advanced` : t`Advanced`}
          </button>

          {showAdvanced && (
            <div className="space-y-3 rounded border p-3">
              <div className="space-y-1">
                <Label htmlFor="ds-interval">
                  <Trans>Poll interval (seconds)</Trans>
                </Label>
                <Input
                  id="ds-interval"
                  type="number"
                  min={60}
                  value={draft.poll_interval_seconds}
                  onChange={(e) => setDraft((d) => ({ ...d, poll_interval_seconds: Number(e.target.value) }))}
                />
                <p className="text-xs text-muted-foreground">
                  <Trans>Minimum 60 — the heartbeat only ticks once a minute.</Trans>
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ds-window">
                  <Trans>Window (days)</Trans>
                </Label>
                <Input
                  id="ds-window"
                  type="number"
                  min={1}
                  value={draft.window_days}
                  onChange={(e) => setDraft((d) => ({ ...d, window_days: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ds-account">
                  <Trans>Account key</Trans>
                </Label>
                <Input
                  id="ds-account"
                  value={draft.account_key}
                  placeholder={accountKeyFor(draft) || t`derived from the fields above`}
                  onChange={(e) => setDraft((d) => ({ ...d, account_key: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  <Trans>This source&apos;s remote identity — one source per account.</Trans>
                </p>
              </div>
              {specFields(spec).filter(([, f]) => f.advanced).map(renderField)}
            </div>
          )}

          {problems.length > 0 && (
            <ul className="space-y-1 rounded bg-destructive/10 p-2 text-xs text-destructive">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void submit()} disabled={busy || problems.length > 0}>
            {busy ? '…' : editing ? t`Save` : t`Add source`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
