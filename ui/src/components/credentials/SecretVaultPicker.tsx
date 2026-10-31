import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Loader2 } from 'lucide-react';
import { credentialsService, type SecretManagerInfo } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { describeApiError } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';

/**
 * Add a vault to the project — a named group of secrets in one secret manager
 * (`secret_vaults` in project_manifest.json, docs/secret_share.md) — then publish this computer's
 * values of `credential` into it. Steps: manager (from the installed managers) → vault name →
 * that manager's own config fields → `credentialsService.addVault` → publish. Only a place is saved, never a value.
 */
export function SecretVaultPicker({
  projectId,
  credential,
  onDone,
  onCancel,
}: {
  projectId: string;
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
      .then((list) => {
        if (!live) return;
        setManagers(list);
        setManager((m) => m || list[0]?.name || '');
      })
      .catch((err) => live && (setManagers([]), setError(describeApiError(err, t`Could not list the secret managers.`).message)));
    return () => {
      live = false;
    };
  }, [t]);

  const chosen = managers?.find((m) => m.name === manager);
  const fields = chosen?.config_fields ?? [];
  const ready = !!chosen && !!vault.trim() && fields.every((f) => !f.required || (config[f.name] ?? '').trim());

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
      await credentialsService.addVault(projectId, name, { manager: chosen.name, config: values });
      if (credential) await credentialsService.publish(credential, projectId, name);
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
      <div>
        <h2 className="text-lg font-semibold">
          <Trans>Secret manager</Trans>
        </h2>
        <p className="text-muted-foreground">
          <Trans>A vault where this project's shared values live. Teammates fetch from it; values never go into Git or a message.</Trans>
        </p>
      </div>
      {managers === null ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup">
          {managers.map((m) => (
            <button
              key={m.name}
              type="button"
              onClick={() => setManager(m.name)}
              className={cn('w-full rounded-md border px-3 py-2 text-start', manager === m.name && 'border-primary')}
              data-testid={`secret-manager-option-${m.name}`}
              aria-pressed={manager === m.name}
            >
              <div className="text-sm font-medium">{m.title || m.name}</div>
              {m.description && <div className="text-xs text-muted-foreground">{m.description}</div>}
            </button>
          ))}
        </div>
      )}
      {chosen && (
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={vault}
            onChange={(e) => setVault(e.target.value)}
            placeholder={t`Vault name`}
            aria-label={t`Vault name`}
            data-testid="secret-vault-name"
          />
          {fields.map((f) => (
            <Input
              key={f.name}
              value={config[f.name] ?? ''}
              onChange={(e) => setConfig((c) => ({ ...c, [f.name]: e.target.value }))}
              placeholder={f.required ? f.label : t`${f.label} (optional)`}
              aria-label={f.label}
              data-testid={`secret-vault-field-${f.name}`}
            />
          ))}
        </div>
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
        <Button onClick={() => void save()} disabled={busy || !ready} data-testid="secret-vault-save">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trans>Save</Trans>}
        </Button>
      </div>
    </div>
  );
}
