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
import { useEffect, useMemo, useState } from 'react';
import { DataSource, type SourceStatus } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
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
  PROVIDERS,
  providerSpec,
  validateDraft,
  type ProviderField,
  type SourceDraft,
} from './provider-catalog';

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
function fieldValue(field: ProviderField, config: Record<string, unknown>): string {
  const raw = config?.[field.key];
  if (raw === undefined || raw === null) return '';
  if (Array.isArray(raw)) return raw.join(field.kind === 'lines' ? '\n' : ', ');
  // Only scalars round-trip through an input. A nested object in config means
  // the driver grew a shape this form does not model — show nothing rather than
  // "[object Object]", which would be saved back verbatim and corrupt it.
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

function draftFrom(source: DataSource): SourceDraft {
  const spec = providerSpec(source.provider);
  const fields: Record<string, string> = {};
  for (const field of spec?.fields ?? []) {
    fields[field.key] = fieldValue(field, source.config ?? {});
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
  };
}

export function DataSourceDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the form edits this source instead of creating one. */
  editing?: DataSource | null;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<SourceDraft>(() => emptyDraft());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(editing ? draftFrom(editing) : emptyDraft());
    setShowAdvanced(false);
  }, [open, editing]);

  const spec = providerSpec(draft.provider);
  const problems = useMemo(() => validateDraft(draft), [draft]);

  const setField = (key: string, value: string) => setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));

  const submit = async () => {
    if (problems.length) return;
    setBusy(true);
    try {
      const config = buildConfig(draft);
      const account = accountKeyFor(draft);
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

  const renderField = (field: ProviderField) => {
    const value = draft.fields[field.key] ?? '';
    return (
      <div key={field.key} className="space-y-1">
        <Label htmlFor={`ds-${field.key}`}>
          {t(field.label)}
          {field.required && <span className="ms-1 text-destructive">*</span>}
        </Label>
        {field.kind === 'lines' ? (
          <Textarea
            id={`ds-${field.key}`}
            rows={3}
            value={value}
            placeholder={field.placeholder ? t(field.placeholder) : undefined}
            onChange={(e) => setField(field.key, e.target.value)}
          />
        ) : (
          <Input
            id={`ds-${field.key}`}
            type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
            value={value}
            placeholder={field.placeholder ? t(field.placeholder) : undefined}
            onChange={(e) => setField(field.key, e.target.value)}
          />
        )}
        {field.hint && <p className="text-xs text-muted-foreground">{t(field.hint)}</p>}
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
            <div className="space-y-1">
              <Label>
                <Trans>Provider</Trans>
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`provider-${p.id}`}
                    onClick={() => setDraft(emptyDraft(p.id))}
                    className={`rounded border p-2 text-start text-xs ${
                      draft.provider === p.id ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                  >
                    <span className="block font-medium">{t(p.label)}</span>
                    <span className="block text-muted-foreground">{t(p.blurb)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="ds-name">
              <Trans>Name</Trans>
              <span className="ms-1 text-destructive">*</span>
            </Label>
            <Input
              id="ds-name"
              value={draft.name}
              placeholder={spec ? t(spec.label) : undefined}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>

          {(spec?.fields ?? []).filter((f) => !f.advanced).map(renderField)}

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
              {(spec?.fields ?? []).filter((f) => f.advanced).map(renderField)}
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
