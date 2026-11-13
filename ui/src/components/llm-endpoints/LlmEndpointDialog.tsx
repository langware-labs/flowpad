/**
 * Add or edit an LLM endpoint. One form for both kinds and both verbs.
 *
 * Kind is chosen once, on create; a root's provider/base_url are shown but
 * disabled on edit (the hub refuses to change them). The credential is NOT part
 * of the entity: on create, the entity is saved first and the typed key is then
 * sent through `setCredential`; on edit, the `CredentialField` talks to the hub
 * directly. Nothing here ever puts the key into an entity payload — see
 * `buildEntityJson`.
 *
 * The two kinds are created by DIFFERENT calls, and that is not symmetry lost for nothing. A root
 * is an ordinary entity create. A chain is `allocate` POSTed to the endpoint it draws from, because
 * the hub authorizes delegation against the budget being delegated — the parent has to be the URL
 * for that check to land on the right entity. Creating a chain as an entity with a `sources` field
 * silently produced a keyless ROOT: the hub drops fields it does not recognise and still answers
 * 200. Editing is an ordinary save for both; the parent is fixed at allocation.
 *
 * **Where it lives** is chosen on create: this machine or the hub (`endpoint-save` holds both save
 * paths). This machine holds roots only, for the providers that `supportsLocal`; a hub-only runtime
 * has no machine and is offered no choice. An edit keeps the destination it was opened with.
 *
 * **A device login** (`device`: a vendor subscription) is an endpoint row too, edited here: its name
 * is shown read-only and only Model sizes (typed — it has no catalog) and custom named models apply.
 */
import { LLM_MODEL_SIZES, type DeviceEndpointWire, type LLMEndpoint, type LLMEndpointKind } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';

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
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { AliasesEditor } from './AliasesEditor';
import { CredentialField } from './CredentialField';
import { FiltersEditor } from './FiltersEditor';
import type { MappingRow } from './filters-limits-forms';
import { LimitsEditor } from './LimitsEditor';
import { draftFor, providersFor, saveEndpoint, type EndpointDestination } from './endpoint-save';
import { hasLocalEndpoints } from './local-endpoints';
import { SourcePicker } from './SourcePicker';
import { TiersEditor } from './TiersEditor';
import { useLlmEndpointChain, useLlmEndpointModels } from './use-llm-endpoints';
import {
  canConfigure,
  catalogFromText,
  draftFrom,
  emptyDraft,
  kindFromChain,
  PROVIDERS,
  providerSpec,
  validateDraft,
  withProvider,
  type EndpointDraft,
} from './endpoint-catalog';

export interface LlmEndpointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the form edits this endpoint instead of creating one. */
  editing?: LLMEndpoint | null;
  /** Every endpoint the user can see — candidates for a chain's sources and
   *  the graph the cycle check runs over. */
  all: readonly LLMEndpoint[];
  /** The chain-resolved kind, when the caller already knows it. The entity's own is always
   *  `root`, so without this an edit on a chain opens a root form. */
  editingKind?: LLMEndpointKind | null;
  /** After a successful save (the live list refetches; the caller may too). */
  onSaved?: (endpoint: LLMEndpoint) => void;
  /** Where the endpoint lives: preselected on create (the API keys tab passes `local`), fixed on
   *  edit. A hub-only runtime always saves to the hub. */
  destination?: EndpointDestination;
  /** The device-login row being edited (`destination` is then `device`): its harness and full
   *  `tiers`, custom names included. */
  device?: DeviceEndpointWire | null;
}

const isSize = (name: string) => (LLM_MODEL_SIZES as readonly string[]).includes(name);

export function LlmEndpointDialog({
  open,
  onOpenChange,
  editing,
  editingKind,
  all,
  onSaved,
  destination: initialDestination = 'hub',
  device = null,
}: LlmEndpointDialogProps) {
  const { t } = useLingui();
  const canChooseLocal = hasLocalEndpoints();
  const openedAs: EndpointDestination = device ? 'device' : canChooseLocal ? initialDestination : 'hub';
  const [destination, setDestination] = useState<EndpointDestination>(openedAs);
  const isDevice = destination === 'device';
  // A device login is this machine's too: everything below that says "local" applies to it.
  const local = destination === 'local' || isDevice;
  const [custom, setCustom] = useState<MappingRow[]>([]);
  // Hub reads only for a hub endpoint: a local one has no hub id to ask about.
  const hubId = open && editing && !local ? editing.id : undefined;
  // The edit form is shaped by root-vs-chain, and `editing.kind` says `root` for everything
  // (`kindFromChain`) — so editing a chain opened a ROOT form, offering provider, base URL and a
  // key it does not have. The detail page already resolved the kind and passes it; the list has no
  // chain to ask, so fetch one here. Cheap: react-query, and the detail's fetch is the same key.
  const ownChain = useLlmEndpointChain(!editingKind ? hubId : undefined);
  const resolvedKind = local ? 'root' : (editingKind ?? (editing ? kindFromChain(ownChain.data, editing.id) : null));
  // Sizes: what each one resolves to today (for "Inherit"), and the models the chain may name.
  const tierChain = useLlmEndpointChain(hubId);
  const allowedModels = useLlmEndpointModels(hubId);
  const [draft, setDraft] = useState<EndpointDraft>(() => emptyDraft('root'));
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [storedHint, setStoredHint] = useState('');

  useEffect(() => {
    if (!open) return;
    const where = openedAs;
    setDestination(where);
    setDraft(editing ? draftFrom(editing, resolvedKind) : draftFor(emptyDraft('root'), where));
    setCustom(
      Object.entries(device?.tiers ?? {})
        .filter(([name]) => !isSize(name))
        .map(([from, to]) => ({ from, to })),
    );
    setStoredHint(editing?.credential_hint ?? '');
    setShowAdvanced(!!editing && resolvedKind === 'chain');
    // `resolvedKind` is deliberately NOT a dependency here. When the dialog fetches its own chain
    // the answer lands a moment AFTER open, and re-running this would re-seed the draft and throw
    // away whatever had been typed in between. The effect below patches the one field that changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, device]);

  useEffect(() => {
    if (!open || !editing || !resolvedKind) return;
    setDraft((d) => (d.kind === resolvedKind ? d : { ...d, kind: resolvedKind }));
    setShowAdvanced(resolvedKind === 'chain');
  }, [open, editing, resolvedKind]);

  // A device row has no provider or base URL to validate: only its sizes and names are edited.
  const problems = useMemo(() => (isDevice ? [] : validateDraft(draft)), [draft, isDevice]);
  const rootCatalog = useMemo(
    () => (draft.kind === 'root' ? catalogFromText(draft.models) : []),
    [draft.kind, draft.models],
  );
  const isEdit = !!editing;
  const readOnly = !!editing && !local && !canConfigure(editing);

  const chooseDestination = (where: EndpointDestination) => {
    setDestination(where);
    setDraft((d) => draftFor(d, where));
  };

  const setKind = (kind: LLMEndpointKind) =>
    setDraft((d) => ({ ...emptyDraft(kind), name: d.name, enabled: d.enabled }));

  const submit = async () => {
    if (problems.length || readOnly) return;
    setBusy(true);
    try {
      const deviceFields = device
        ? { harness: device.harness, custom: Object.fromEntries(custom.map((r) => [r.from, r.to])) }
        : {};
      const {
        endpoint: saved,
        outcome,
        message,
      } = await saveEndpoint(destination, { ...draft, ...deviceFields }, editing ?? null);
      const name = draft.name.trim();
      // The wording is the dialog's; what happened is the adapter's.
      if (outcome === 'updated') notify.success({ title: t`Updated ${name}` });
      else if (outcome === 'added_local') notify.success({ title: t`Added ${name} on this machine` });
      else if (outcome === 'added_local_key_refused') {
        notify.success({ title: t`Added ${name} on this machine` });
        notify.warning({ title: t`The provider refused this key`, message: message ?? '' });
      } else if (outcome === 'allocated') notify.success({ title: t`Allocated ${name}` });
      else if (outcome === 'added_with_key') notify.success({ title: t`Added ${name} and stored its key` });
      else if (outcome === 'added_key_failed') {
        // The endpoint exists; only the key failed. Say so — the user can paste it again from the
        // edit dialog.
        notify.error({ title: t`Added ${name}, but the key was not saved`, message: message ?? '' });
      } else notify.success({ title: t`Added ${name}` });
      setDraft((d) => ({ ...d, key: '' }));
      onSaved?.(saved);
      onOpenChange(false);
    } catch (e) {
      notify.error({ title: t`Could not save the endpoint`, message: errorMessage(e, '') });
    } finally {
      setBusy(false);
    }
  };

  const spec = providerSpec(draft.provider);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="llm-endpoint-dialog">
        <DialogHeader>
          <DialogTitle>{isDevice ? t`Edit device login` : isEdit ? t`Edit endpoint` : t`New endpoint`}</DialogTitle>
          <DialogDescription>
            {isDevice ? (
              <Trans>
                Paid by your {device?.harness ?? ''} subscription. Choose the model each size runs; an empty size is the
                assistant's own default.
              </Trans>
            ) : local ? (
              <Trans>Stored on this machine. Limits, filters and model sizes work as on a hub endpoint.</Trans>
            ) : draft.kind === 'root' ? (
              <Trans>Funded by a provider API key you supply.</Trans>
            ) : (
              <Trans>Funded by an existing source; it can only narrow what that source allows.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isEdit && canChooseLocal && (
            <div className="space-y-1">
              <Label>
                <Trans>Where</Trans>
              </Label>
              <div className="grid grid-cols-2 gap-2" data-testid="llm-destination">
                {(['local', 'hub'] as const).map((where) => (
                  <button
                    key={where}
                    type="button"
                    data-testid={`destination-${where}`}
                    aria-pressed={destination === where}
                    onClick={() => chooseDestination(where)}
                    className={`rounded border p-2 text-start text-xs ${
                      destination === where ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                  >
                    <span className="block font-medium">{where === 'local' ? t`This machine` : t`On the hub`}</span>
                    <span className="block text-muted-foreground">
                      {where === 'local' ? t`The key is stored here` : t`A budget others can share`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!isEdit && !local && (
            <div className="space-y-1">
              <Label>
                <Trans>Funding source</Trans>
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {(['root', 'chain'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    data-testid={`kind-${kind}`}
                    onClick={() => setKind(kind)}
                    className={`rounded border p-2 text-start text-xs ${
                      draft.kind === kind ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                  >
                    <span className="block font-medium">{kind === 'root' ? t`API key` : t`Existing source`}</span>
                    <span className="block text-muted-foreground">
                      {kind === 'root' ? t`Your own provider key` : t`Draw from a source you can use`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="llm-name">
              <Trans>Name</Trans>
              <span className="ms-1 text-destructive">*</span>
            </Label>
            <Input
              id="llm-name"
              autoComplete="off"
              value={draft.name}
              disabled={readOnly || isDevice}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              data-testid="llm-name"
            />
          </div>

          {draft.kind === 'root' && !isDevice && (
            <>
              <div className="space-y-1">
                <Label>
                  <Trans>Provider</Trans>
                </Label>
                <div className="grid grid-cols-3 gap-2">
                  {providersFor(PROVIDERS, destination).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      data-testid={`provider-${p.id}`}
                      disabled={isEdit}
                      onClick={() => setDraft((d) => withProvider(d, p.id))}
                      className={`rounded border p-2 text-start text-xs disabled:opacity-60 ${
                        draft.provider === p.id ? 'border-primary bg-primary/5' : 'border-border'
                      }`}
                    >
                      <span className="block font-medium">{t(p.label)}</span>
                      <span className="block truncate text-muted-foreground">{p.defaultBaseUrl}</span>
                    </button>
                  ))}
                </div>
                {isEdit && (
                  <p className="text-xs text-muted-foreground">
                    <Trans>Provider and base URL are fixed once created.</Trans>
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="llm-base-url">
                  <Trans>Base URL</Trans>
                </Label>
                <Input
                  id="llm-base-url"
                  type="url"
                  autoComplete="url"
                  value={draft.base_url}
                  disabled={isEdit && !local}
                  placeholder={spec?.defaultBaseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
                  data-testid="llm-base-url"
                />
              </div>
              <CredentialField
                endpointId={local ? undefined : editing?.id}
                provider={draft.provider}
                credentialHint={storedHint}
                placeholder={spec?.keyPlaceholder}
                value={draft.key}
                onChange={(key) => setDraft((d) => ({ ...d, key }))}
                onStored={setStoredHint}
                disabled={readOnly}
              />
            </>
          )}

          {draft.kind === 'chain' && !isEdit && (
            <SourcePicker
              value={draft.source}
              onChange={(source) => setDraft((d) => ({ ...d, source }))}
              all={all}
              disabled={readOnly}
            />
          )}

          {!isDevice && (
            <div className="flex items-center justify-between rounded border p-2">
              <Label htmlFor="llm-enabled" className="text-sm">
                <Trans>Enabled</Trans>
              </Label>
              <Switch
                id="llm-enabled"
                checked={draft.enabled}
                disabled={readOnly}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
              />
            </div>
          )}

          {draft.kind === 'root' && !local && (
            <div className="space-y-1">
              <Label htmlFor="llm-models">
                <Trans>Model catalog</Trans>
              </Label>
              <Textarea
                id="llm-models"
                data-testid="llm-models"
                rows={3}
                value={draft.models}
                disabled={readOnly}
                placeholder={t`One model per line. Empty = whatever the provider lists.`}
                onChange={(e) => setDraft((d) => ({ ...d, models: e.target.value }))}
              />
            </div>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              <Trans>Model sizes</Trans>
            </h4>
            <TiersEditor
              value={draft.tiers}
              onChange={(tiers) => setDraft((d) => ({ ...d, tiers }))}
              models={rootCatalog.length ? rootCatalog : (allowedModels.data ?? []).map((m) => m.id)}
              effective={tierChain.data?.effective_tiers}
              disabled={readOnly}
              freeText={isDevice}
              emptyLabel={t`Assistant default`}
            />
          </div>

          {isDevice && (
            <AliasesEditor
              title={t`Custom models`}
              rows={custom}
              onChange={setCustom}
              disabled={busy}
              testId="device-custom-models"
            />
          )}

          {!isDevice && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAdvanced((v) => !v)}
              data-testid="toggle-advanced"
            >
              {showAdvanced ? t`Hide filters & limits` : t`Filters & limits`}
            </button>
          )}

          {showAdvanced && !isDevice && (
            <div className="space-y-4 rounded border p-3">
              <h4 className="text-sm font-medium">
                <Trans>Filters</Trans>
              </h4>
              <FiltersEditor
                value={draft.filters}
                onChange={(filters) => setDraft((d) => ({ ...d, filters }))}
                disabled={readOnly}
              />
              <h4 className="text-sm font-medium">
                <Trans>Limits</Trans>
              </h4>
              <LimitsEditor
                value={draft.limits}
                onChange={(limits) => setDraft((d) => ({ ...d, limits }))}
                disabled={readOnly}
              />
            </div>
          )}

          {problems.length > 0 && (
            <ul className="space-y-1 rounded bg-destructive/10 p-2 text-xs text-destructive" data-testid="llm-problems">
              {problems.map((p) => (
                <li key={p.id}>{t(p)}</li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || readOnly || problems.length > 0}
            data-testid="llm-submit"
          >
            {busy ? '…' : isEdit ? t`Save` : t`Create`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
