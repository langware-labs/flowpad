import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, Info, Plus, X } from 'lucide-react';
import {
  credentialsService,
  secretApprovalGate,
  type CredentialSaved,
  type CredentialScopeName,
  type CredentialsStatus,
  type CredentialValueStore,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { WikiButton } from '@src/components/wiki-tip/WikiButton';
import { describeApiError } from '@src/lib/error-message';
import { takenInScope } from '@src/components/credentials-view/credential-rows';
import {
  asksDefinition,
  asksValues,
  draftValues,
  emptyVar,
  hasProblems,
  namesLocked,
  scopeLocked,
  storeLocked,
  toSaveRequest,
  validateDraft,
  type CredentialDraft,
  type DraftProblem,
  type DraftVar,
} from './credential-draft';
import { EnvLocalBlockedNotice } from './EnvLocalBlockedNotice';
import { SecretValueInput } from './SecretValueInput';

/** The wiki page the scope and storage info icons open, one section each. */
const SECRETS_WIKI = 'Secrets';

export interface CredentialDialogProps {
  /** The draft the form starts from. Render a fresh dialog (a new `key`) per draft. */
  draft: CredentialDraft;
  onClose: () => void;
  /** The selected project, when there is one — required for project scope. */
  projectId: string | null;
  status: CredentialsStatus;
  /** Re-read status (after enabling the vault). */
  onRefresh: () => void | Promise<void>;
  onSaved: (saved: CredentialSaved) => void | Promise<void>;
}

/**
 * The one form for declaring secrets.
 *
 * In its basic form a secret is a pack name and name + value pairs. Everything
 * else — where it applies, where values are stored, descriptions, masking —
 * sits behind Advanced, with defaults that fit most packs: this project, the
 * `.env.local` file.
 */
export function CredentialDialog({ draft, onClose, projectId, status, onRefresh, onSaved }: CredentialDialogProps) {
  const { t } = useLingui();
  const [d, setD] = React.useState<CredentialDraft>(draft);
  const [advanced, setAdvanced] = React.useState(false);
  const [attempted, setAttempted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  const update = (patch: Partial<CredentialDraft>) => setD((prev) => ({ ...prev, ...patch }));
  const updateVar = (id: string, patch: Partial<DraftVar>) =>
    setD((prev) => ({ ...prev, vars: prev.vars.map((v) => (v.id === id ? { ...v, ...patch } : v)) }));

  const taken = takenInScope(status, d.scope, d.typeid);
  const problems = validateDraft(d, taken);
  const file = status.files.find((f) => f.scope === d.scope);
  const writesToFile = d.store === 'env' && asksValues(d) && Object.keys(draftValues(d)).length > 0;
  const fileBlocked = writesToFile && !!file?.blocked;
  const vaultDisabled = d.store === 'vault' && !status.vault_enabled;
  const locked = namesLocked(d);
  const editsDefinition = asksDefinition(d) && d.mode !== 'template';
  const editsVariables = d.mode === 'custom' || d.mode === 'edit';
  const hasAdvanced = asksDefinition(d);

  const problemText = (p: DraftProblem): string =>
    ({
      'title-required': t`Give the pack a name`,
      'no-vars': t`Add at least one variable`,
      'bad-env-var': t`Letters, digits and _ only`,
      duplicate: t`Listed twice`,
      taken: t`Already in another pack here`,
      'required-value': t`Required`,
      'too-long': t`Too long`,
      pattern: t`Does not look right`,
    })[p];

  const title = (() => {
    switch (d.mode) {
      case 'custom':
        return t`New secret`;
      case 'pack':
        return t`Pack keys into a secret`;
      case 'edit':
        return t`Edit ${d.title}`;
      case 'values':
        return t`${d.title} values`;
      default:
        return d.title;
    }
  })();

  const save = async () => {
    setAttempted(true);
    setFailure(null);
    if (hasProblems(problems) || fileBlocked || vaultDisabled) return;
    setBusy(true);
    try {
      const saved =
        d.mode === 'values' && d.typeid
          ? await credentialsService.setValues(d.typeid, draftValues(d))
          : await credentialsService.save(toSaveRequest(d, projectId));
      await onSaved(saved);
    } catch (error) {
      const { code, message } = describeApiError(error, t`The secret could not be saved.`);
      setFailure(code === 'vault-disabled' ? t`The encrypted vault is not enabled on this machine yet.` : message);
    } finally {
      setBusy(false);
    }
  };

  const enableVault = async () => {
    try {
      await secretApprovalGate.request();
    } finally {
      await onRefresh();
    }
  };

  const shownProblem = (v: DraftVar): DraftProblem | null => {
    const problem = problems.vars[v.id];
    if (!problem) return null;
    return attempted || (problem !== 'required-value' && (v.envVar !== '' || v.value !== '')) ? problem : null;
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-xl" data-testid="credential-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto pe-1">
          {editsDefinition && (
            <div className="space-y-1">
              <Label htmlFor="credential-title" className="text-xs">
                <Trans>Pack name</Trans>
              </Label>
              <Input
                id="credential-title"
                autoFocus
                value={d.title}
                placeholder={t`e.g. Stripe`}
                onChange={(e) => update({ title: e.target.value })}
                data-testid="credential-title"
              />
              {attempted && problems.form.includes('title-required') && (
                <p className="text-xs text-destructive">{problemText('title-required')}</p>
              )}
            </div>
          )}

          <div className="space-y-2">
            {d.vars.map((v, index) => {
              const problem = shownProblem(v);
              return (
                <div key={v.id} className="space-y-1" data-testid={`credential-var-${index}`}>
                  <div className="flex items-center gap-2">
                    {locked ? (
                      <code
                        className="flex h-9 w-44 shrink-0 items-center truncate rounded-md bg-muted px-2 text-xs"
                        title={v.envVar}
                        data-testid={`credential-var-name-${index}`}
                      >
                        {v.envVar}
                      </code>
                    ) : (
                      <Input
                        value={v.envVar}
                        placeholder={t`NAME`}
                        className="w-44 shrink-0 font-mono text-xs"
                        onChange={(e) => updateVar(v.id, { envVar: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                        aria-label={t`Variable name`}
                        data-testid={`credential-var-name-${index}`}
                      />
                    )}
                    {asksValues(d) ? (
                      <SecretValueInput
                        className="min-w-0 flex-1"
                        secret={v.secret}
                        value={v.value}
                        placeholder={v.placeholder || (d.mode === 'values' ? t`Leave empty to keep` : t`Value`)}
                        disabled={busy}
                        onValueChange={(value) => updateVar(v.id, { value })}
                        aria-label={t`Value for ${v.envVar || 'variable'}`}
                        data-testid={`credential-var-value-${index}`}
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {d.mode === 'pack' ? <Trans>Value stays in .env.local</Trans> : v.description}
                      </span>
                    )}
                    {editsVariables && d.vars.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 shrink-0 p-0 text-muted-foreground"
                        onClick={() => update({ vars: d.vars.filter((x) => x.id !== v.id) })}
                        aria-label={t`Remove variable`}
                        data-testid={`credential-var-remove-${index}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  {problem && (
                    <p className="text-xs text-destructive" data-testid={`credential-var-problem-${index}`}>
                      {problemText(problem)}
                    </p>
                  )}
                </div>
              );
            })}
            {editsVariables && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-muted-foreground"
                onClick={() => update({ vars: [...d.vars, emptyVar()] })}
                data-testid="credential-add-var"
              >
                <Plus className="h-3.5 w-3.5" />
                <Trans>Add variable</Trans>
              </Button>
            )}
          </div>

          {vaultDisabled && (
            <div
              className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
              data-testid="vault-disabled-notice"
            >
              <span>
                <Trans>The encrypted vault is not enabled on this machine yet.</Trans>
              </span>
              <Button size="sm" variant="outline" onClick={() => void enableVault()} data-testid="vault-enable">
                <Trans>Enable vault</Trans>
              </Button>
            </div>
          )}
          {fileBlocked && <EnvLocalBlockedNotice reason={file?.block_reason} />}

          {hasAdvanced && (
            <div className="border-t pt-3">
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setAdvanced((a) => !a)}
                aria-expanded={advanced}
                data-testid="credential-advanced-toggle"
              >
                {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <Trans>Advanced</Trans>
              </button>

              {advanced && (
                <div className="mt-3 space-y-4" data-testid="credential-advanced">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FieldSelect<CredentialScopeName>
                      id="credential-scope"
                      label={t`Scope`}
                      fragment="scope"
                      value={d.scope}
                      disabled={scopeLocked(d)}
                      onChange={(scope) => update({ scope })}
                      options={[
                        { value: 'project', label: t`This project`, disabled: !projectId },
                        { value: 'user', label: t`All my projects` },
                      ]}
                    />
                    <FieldSelect<CredentialValueStore>
                      id="credential-store"
                      label={t`Storage`}
                      fragment="storage"
                      value={d.store}
                      disabled={storeLocked(d)}
                      onChange={(store) => update({ store })}
                      options={[
                        { value: 'env', label: t`.env.local file` },
                        { value: 'vault', label: t`Encrypted vault` },
                      ]}
                    />
                  </div>

                  {editsDefinition && (
                    <div className="space-y-1">
                      <Label htmlFor="credential-description" className="text-xs">
                        <Trans>Description</Trans>
                      </Label>
                      <Textarea
                        id="credential-description"
                        rows={2}
                        value={d.description}
                        placeholder={t`What it is for`}
                        onChange={(e) => update({ description: e.target.value })}
                        data-testid="credential-description"
                      />
                    </div>
                  )}

                  {editsDefinition && (
                    <div className="space-y-2">
                      <Label className="text-xs">
                        <Trans>Variables</Trans>
                      </Label>
                      {d.vars.map((v, index) => (
                        <div key={v.id} className="flex items-center gap-2">
                          <code className="w-44 shrink-0 truncate text-xs" title={v.envVar}>
                            {v.envVar || '—'}
                          </code>
                          <Input
                            value={v.description}
                            placeholder={t`Description`}
                            className="h-8 min-w-0 flex-1 text-xs"
                            onChange={(e) => updateVar(v.id, { description: e.target.value })}
                            aria-label={t`Description for ${v.envVar || 'variable'}`}
                            data-testid={`credential-var-description-${index}`}
                          />
                          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <Switch
                              checked={v.secret}
                              onCheckedChange={(secret) => updateVar(v.id, { secret })}
                              data-testid={`credential-var-secret-${index}`}
                            />
                            <Trans>Masked</Trans>
                          </label>
                        </div>
                      ))}
                    </div>
                  )}

                  {d.mode === 'template' && d.vars.some((v) => v.helpUrl || v.description) && (
                    <div className="space-y-1 text-xs text-muted-foreground">
                      {d.vars.map((v) =>
                        v.helpUrl || v.description ? (
                          <p key={v.id}>
                            <code>{v.envVar}</code> — {v.description}{' '}
                            {v.helpUrl && (
                              <a href={v.helpUrl} target="_blank" rel="noreferrer" className="underline">
                                <Trans>Where do I get this?</Trans>
                              </a>
                            )}
                          </p>
                        ) : null,
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {failure && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm" data-testid="credential-failure">
              {failure}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void save()} disabled={busy || fileBlocked || vaultDisabled} data-testid="credential-save">
            {busy ? <Trans>Saving…</Trans> : d.mode === 'values' || d.typeid ? <Trans>Save</Trans> : <Trans>Add</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FieldOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** A labelled select with an info icon that opens this field's wiki section. */
function FieldSelect<T extends string>({
  id,
  label,
  fragment,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  fragment: string;
  value: T;
  options: FieldOption<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <WikiButton
          wikiword={SECRETS_WIKI}
          fragment={fragment}
          label={t`About ${label}`}
          className="flex items-center text-muted-foreground/70 hover:text-primary"
          data-testid={`${id}-info`}
        >
          <Info className="h-3.5 w-3.5" />
        </WikiButton>
      </div>
      <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
        <SelectTrigger id={id} className="h-9" data-testid={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              data-testid={`${id}-${option.value}`}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
