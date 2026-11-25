import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { KeyRound, Loader2 } from 'lucide-react';
import { credentialsService, type SecretManagerInfo, type SecretVault } from '@sdk';
import { flowIconComponent } from '@sdk/react/FlowIcon';
import { DesktopTile, TILE_TIP_DELAY, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { StepCrumbs } from '@src/components/ui/stepped-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { describeApiError } from '@src/lib/error-message';

/** The manager's own mark (`icon` in its secret_manager.json), a key when it names none. */
function managerIcon(m: SecretManagerInfo) {
  return m.icon ? flowIconComponent(m.icon) : KeyRound;
}

function managerLabel(m: SecretManagerInfo) {
  return m.title || m.name;
}

/** The chosen manager's opening card: its mark, its name, what it is. */
function ManagerIntro({ manager }: { manager: SecretManagerInfo }) {
  const Icon = managerIcon(manager);
  return (
    <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3" data-testid="secret-manager-intro">
      <Icon className="h-10 w-10 shrink-0" />
      <div className="min-w-0">
        <div className="font-medium">{managerLabel(manager)}</div>
        {manager.description && <p className="text-xs text-muted-foreground">{manager.description}</p>}
      </div>
    </div>
  );
}

function Field({
  label,
  optional,
  value,
  onChange,
  autoFocus,
  testId,
}: {
  label: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  testId: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium">
      <span>
        {label}
        {optional && (
          <span className="ms-1 font-normal text-muted-foreground">
            <Trans>(optional)</Trans>
          </span>
        )}
      </span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} data-testid={testId} />
    </label>
  );
}

/**
 * Add a vault to the project — a named group of secrets in one secret manager
 * (`secret_vaults` in project_manifest.json, docs/secret_share.md) — then publish this computer's
 * values of `credential` into it. Two steps in place, like adding a connection: a tile per installed
 * manager, then that manager's own screen (its mark, what it is, vault name and its config fields) →
 * `credentialsService.addVault` → publish. Only a place is saved, never a value.
 */
export function SecretVaultPicker({
  projectId,
  credential,
  onSave,
  onDone,
  onCancel,
}: {
  projectId: string;
  /** Saves the vault somewhere else than the project (the instance's global vault): no name is asked. */
  onSave?: (vault: SecretVault) => Promise<void>;
  /** The credential being shared: its local values are published into the new vault. */
  credential?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [managers, setManagers] = useState<SecretManagerInfo[] | null>(null);
  const [manager, setManager] = useState<string>('');
  const [vault, setVault] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    credentialsService
      .listManagers()
      .then((list) => live && setManagers(list))
      .catch((err) => live && (setManagers([]), setError(describeApiError(err, t`Could not list the secret managers.`).message)));
    return () => {
      live = false;
    };
  }, [t]);

  const chosen = managers?.find((m) => m.name === manager);
  const fields = chosen?.config_fields ?? [];
  const ready = (!!onSave || !!vault.trim()) && fields.every((f) => !f.required || (config[f.name] ?? '').trim());

  const save = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const name = vault.trim();
      const values = Object.fromEntries(
        Object.entries(config)
          .map(([k, v]) => [k, v.trim()] as const)
          .filter(([, v]) => v),
      );
      if (onSave) {
        await onSave({ manager: chosen.name, config: values });
      } else {
        await credentialsService.addVault(projectId, name, { manager: chosen.name, config: values });
        if (credential) await credentialsService.publish(credential, projectId, name);
      }
      onDone();
    } catch (err) {
      const { code, message } = describeApiError(err, t`Could not save the vault.`);
      setError(code === 'needs_connection' ? t`Sign in to ${chosen.title} first, then save again.` : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="secret-vault-picker">
      <div className="flex flex-col gap-1.5">
        <h2>
          <StepCrumbs
            crumbs={
              chosen
                ? [{ label: t`Secret manager`, onClick: busy ? undefined : () => setManager('') }, { label: managerLabel(chosen) }]
                : [{ label: t`Secret manager` }]
            }
          />
        </h2>
        {!chosen && (
          <p className="text-muted-foreground">
            <Trans>A vault where this project's shared values live. Teammates fetch from it; values never go into Git or a message.</Trans>
          </p>
        )}
      </div>
      {managers === null ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : !chosen ? (
        <TileSection title={<Trans>Keep the values in</Trans>}>
          {managers.map((m) => (
            <Tooltip key={m.name} delayDuration={TILE_TIP_DELAY}>
              <TooltipTrigger asChild>
                <DesktopTile
                  Icon={managerIcon(m)}
                  label={managerLabel(m)}
                  data-testid={`secret-manager-option-${m.name}`}
                  onClick={() => {
                    setManager(m.name);
                    setConfig({});
                    setError(null);
                  }}
                />
              </TooltipTrigger>
              {/* The tile clips a long name; the tip carries it whole, with what the manager is. */}
              <TooltipContent side="bottom" className="max-w-xs">
                <div className="font-medium">{managerLabel(m)}</div>
                {m.description && <div>{m.description}</div>}
              </TooltipContent>
            </Tooltip>
          ))}
        </TileSection>
      ) : (
        <>
          <ManagerIntro manager={chosen} />
          <div className="flex flex-col gap-3">
            {!onSave && (
              <Field label={t`Vault name`} value={vault} onChange={setVault} autoFocus testId="secret-vault-name" />
            )}
            {fields.map((f) => (
              <Field
                key={f.name}
                label={f.label}
                optional={!f.required}
                value={config[f.name] ?? ''}
                onChange={(v) => setConfig((c) => ({ ...c, [f.name]: v }))}
                testId={`secret-vault-field-${f.name}`}
              />
            ))}
          </div>
        </>
      )}
      {credential && (
        <p className="text-xs text-muted-foreground">
          <Trans>Your local value of {credential} is copied into the vault, and the credential records where it is.</Trans>
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" data-testid="secret-vault-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          <Trans>Cancel</Trans>
        </Button>
        {chosen && (
          <Button onClick={() => void save()} disabled={busy || !ready} data-testid="secret-vault-save">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trans>Save</Trans>}
          </Button>
        )}
      </div>
    </div>
  );
}
