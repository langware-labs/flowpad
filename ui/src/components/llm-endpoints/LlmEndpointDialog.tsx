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
 */
import { LLMEndpoint, dataManager, llmEndpointsService, type LLMEndpointKind } from '@sdk';
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
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { CredentialField } from './CredentialField';
import { FiltersEditor } from './FiltersEditor';
import { LimitsEditor } from './LimitsEditor';
import { endpointIdFromTypeId } from './llm-endpoints-pointer';
import { SourcePicker } from './SourcePicker';
import {
  buildAllocateBody,
  buildEntityJson,
  canConfigure,
  draftFrom,
  emptyDraft,
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
  /** After a successful save (the live list refetches; the caller may too). */
  onSaved?: (endpoint: LLMEndpoint) => void;
}

export function LlmEndpointDialog({ open, onOpenChange, editing, all, onSaved }: LlmEndpointDialogProps) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<EndpointDraft>(() => emptyDraft('root'));
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [storedHint, setStoredHint] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraft(editing ? draftFrom(editing) : emptyDraft('root'));
    setStoredHint(editing?.credential_hint ?? '');
    setShowAdvanced(!!editing && editing.kind === 'chain');
  }, [open, editing]);

  const problems = useMemo(() => validateDraft(draft), [draft]);
  const isEdit = !!editing;
  const readOnly = !!editing && !canConfigure(editing);

  const setKind = (kind: LLMEndpointKind) =>
    setDraft((d) => ({ ...emptyDraft(kind), name: d.name, enabled: d.enabled }));

  const submit = async () => {
    if (problems.length || readOnly) return;
    setBusy(true);
    try {
      const json = buildEntityJson(draft, isEdit);
      let saved: LLMEndpoint;
      if (editing) {
        saved = await dataManager.save<LLMEndpoint>(editing.typeId, [], json as never);
        notify.success({ title: t`Updated ${draft.name.trim()}` });
      } else if (draft.kind === 'chain') {
        // The parent is the URL, not a field — see the module note.
        saved = await llmEndpointsService.allocate(endpointIdFromTypeId(draft.source), buildAllocateBody(draft));
        notify.success({ title: t`Allocated ${draft.name.trim()}` });
      } else {
        const fresh = new LLMEndpoint(json as never);
        saved = await dataManager.save<LLMEndpoint>(fresh.typeId, [], json as never);
        const id = saved?.id ?? fresh.id;
        if (draft.key.trim() && id) {
          try {
            await llmEndpointsService.setCredential(id, draft.key.trim());
            notify.success({ title: t`Added ${draft.name.trim()} and stored its key` });
          } catch (e) {
            // The endpoint exists; only the key failed. Say so — the user can
            // paste it again from the edit dialog.
            notify.error({
              title: t`Added ${draft.name.trim()}, but the key was not saved`,
              message: errorMessage(e, ''),
            });
          }
        } else {
          notify.success({ title: t`Added ${draft.name.trim()}` });
        }
      }
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
          <DialogTitle>{isEdit ? t`Edit endpoint` : t`New endpoint`}</DialogTitle>
          <DialogDescription>
            {draft.kind === 'root' ? (
              <Trans>A root talks to a provider with its own key.</Trans>
            ) : (
              <Trans>A chain draws on another endpoint and can only narrow what passes.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isEdit && (
            <div className="space-y-1">
              <Label>
                <Trans>Kind</Trans>
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
                    <span className="block font-medium">{kind === 'root' ? t`Root` : t`Chain`}</span>
                    <span className="block text-muted-foreground">
                      {kind === 'root' ? t`Provider + credential` : t`Sources + filters + limits`}
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
              value={draft.name}
              disabled={readOnly}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              data-testid="llm-name"
            />
          </div>

          {draft.kind === 'root' && (
            <>
              <div className="space-y-1">
                <Label>
                  <Trans>Provider</Trans>
                </Label>
                <div className="grid grid-cols-3 gap-2">
                  {PROVIDERS.map((p) => (
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
                  value={draft.base_url}
                  disabled={isEdit}
                  placeholder={spec?.defaultBaseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
                  data-testid="llm-base-url"
                />
              </div>
              <CredentialField
                endpointId={editing?.id}
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

          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowAdvanced((v) => !v)}
            data-testid="toggle-advanced"
          >
            {showAdvanced ? t`Hide filters & limits` : t`Filters & limits`}
          </button>

          {showAdvanced && (
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
