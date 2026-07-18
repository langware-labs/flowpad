import { Trans, useLingui } from '@lingui/react/macro';
import type { Project, SecretOriginLocator, SodStore } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { useProjectSecretOrigins } from '@src/hooks/use-project-secret-origins';
import { Check, KeyRound, Loader2, Plus, TriangleAlert, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';

/** Provider kinds (where to FETCH the value). Labels + the primary coordinate
 *  field come from here — the FE never branches on kind for behavior, only for
 *  the input label; resolution/status is entirely backend-driven. */
const PROVIDERS: {
  kind: SecretOriginLocator['kind'];
  label: string;
  coordLabel: string;
  coordField: string;
  defaultStore: SodStore;
}[] = [
  { kind: 'local', label: 'Encrypted keychain (sodot)', coordLabel: 'Secret name', coordField: 'sod_name', defaultStore: 'sodot' },
  { kind: 'env-local', label: 'Project .env.local', coordLabel: 'Env key', coordField: 'env_key', defaultStore: 'env-local' },
  { kind: 'gcp', label: 'Google Secret Manager', coordLabel: 'Secret resource', coordField: 'secret', defaultStore: 'sodot' },
  { kind: '1password', label: '1Password', coordLabel: 'Item', coordField: 'item', defaultStore: 'sodot' },
  { kind: 'flowpad-hub', label: 'Flowpad Hub', coordLabel: 'Secret id', coordField: 'secret_id', defaultStore: 'sodot' },
];

interface SecretsCardProps {
  project: Project | null | undefined;
}

/**
 * Project Secrets card — the two-layer model surfaced: reference (value-free
 * pointer) + value store. Each row shows where to FETCH (provider), how to STORE
 * (SOD store), how to USE (env var), and whether it resolves on this machine.
 * Missing secrets launch the inline setup wizard. Headless: all logic is backend.
 */
export const SecretsCard: React.FC<SecretsCardProps> = ({ project }) => {
  const { t } = useLingui();
  const { secretOrigins, status, add, provide, remove } = useProjectSecretOrigins(project);

  const statusByTypeId = useMemo(
    () => new Map(status.map((s) => [s.typeid, s])),
    [status],
  );

  const [busy, setBusy] = useState(false);
  const [wizardFor, setWizardFor] = useState<string | null>(null);
  const [wizardValue, setWizardValue] = useState('');

  // Add form
  const [envVar, setEnvVar] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SecretOriginLocator['kind']>('local');
  const [coord, setCoord] = useState('');
  const [scope, setScope] = useState<'private' | 'shared'>('private');

  const provider = PROVIDERS.find((p) => p.kind === kind) ?? PROVIDERS[0];

  const handleAdd = async () => {
    const ev = envVar.trim();
    if (!ev) return;
    const coordVal = coord.trim() || (kind === 'env-local' ? ev : name.trim() || ev);
    const locator = { kind, [provider.coordField]: coordVal } as unknown as SecretOriginLocator;
    setBusy(true);
    try {
      await add({
        name: name.trim() || coordVal,
        envVar: ev,
        locator,
        sodStore: provider.defaultStore,
        scope: kind === 'local' ? 'private' : scope,
      });
      setEnvVar('');
      setName('');
      setCoord('');
    } catch (e) {
      notify.error({ title: t`Error`, message: e instanceof Error ? e.message : t`Failed to add secret` });
    } finally {
      setBusy(false);
    }
  };

  const handleProvide = async (typeid: string) => {
    if (!wizardValue.trim()) return;
    setBusy(true);
    try {
      await provide({ typeid, value: wizardValue });
      setWizardFor(null);
      setWizardValue('');
    } catch (e) {
      notify.error({ title: t`Error`, message: e instanceof Error ? e.message : t`Failed to store value` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border p-3" data-testid="secrets-card">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <KeyRound className="h-4 w-4" />
        <Trans>Secrets</Trans>
      </div>

      {secretOrigins.length === 0 ? (
        <div className="px-1 py-1 text-[11px] text-muted-foreground">
          <Trans>No secrets yet. Add one below — the value never leaves your machine.</Trans>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {secretOrigins.map((s) => {
            const st = statusByTypeId.get(s.typeid);
            const available = st?.status === 'available';
            const comingSoon = st?.setup_hint?.coming_soon;
            return (
              <li
                key={s.typeid}
                className="flex flex-col gap-1 rounded border border-border/60 px-2 py-1.5 text-xs"
                data-testid={`secret-row-${s.env_var}`}
              >
                <div className="flex items-center gap-2">
                  <code className="font-medium">{s.env_var}</code>
                  <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{s.kind}</span>
                  <span className="text-[10px] text-muted-foreground">→ {s.sod_store || 'sodot'}</span>
                  <span
                    className={`ml-auto flex items-center gap-0.5 text-[10px] ${available ? 'text-green-600' : 'text-amber-600'}`}
                    data-testid={`secret-status-${s.env_var}`}
                  >
                    {available ? <Check className="h-3 w-3" /> : <TriangleAlert className="h-3 w-3" />}
                    {available ? <Trans>Available</Trans> : <Trans>Missing</Trans>}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${s.env_var}`}
                    data-testid={`secret-remove-${s.env_var}`}
                    onClick={() => void remove(s.typeid)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {!available && (
                  <div className="flex items-center gap-1.5">
                    {wizardFor === s.typeid ? (
                      <>
                        <Input
                          type="password"
                          autoFocus
                          value={wizardValue}
                          onChange={(e) => setWizardValue(e.target.value)}
                          placeholder={st?.setup_hint?.prompt || t`Enter value`}
                          className="h-6 flex-1 text-[11px]"
                          data-testid={`secret-value-input-${s.env_var}`}
                        />
                        <Button
                          size="sm"
                          className="h-6 text-[10px]"
                          disabled={busy || !wizardValue.trim()}
                          onClick={() => void handleProvide(s.typeid)}
                          data-testid={`secret-save-${s.env_var}`}
                        >
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trans>Save</Trans>}
                        </Button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setWizardFor(s.typeid); setWizardValue(''); }}
                        className="text-[10px] text-primary hover:underline"
                        data-testid={`secret-setup-${s.env_var}`}
                      >
                        {comingSoon ? (st?.setup_hint?.prompt || t`Set up`) : <Trans>Set up →</Trans>}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add form — provider (fetch) · coordinate · env var (use) · scope */}
      <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={envVar}
            onChange={(e) => setEnvVar(e.target.value.toUpperCase())}
            placeholder={t`ENV_VAR`}
            className="h-7 flex-1 text-[11px]"
            data-testid="secret-add-envvar"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SecretOriginLocator['kind'])}
            className="h-7 rounded border border-border bg-background px-1 text-[11px]"
            data-testid="secret-add-kind"
          >
            {PROVIDERS.map((p) => (
              <option key={p.kind} value={p.kind}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={coord}
            onChange={(e) => setCoord(e.target.value)}
            placeholder={provider.coordLabel}
            className="h-7 flex-1 text-[11px]"
            data-testid="secret-add-coord"
          />
          {kind !== 'local' && (
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'private' | 'shared')}
              className="h-7 rounded border border-border bg-background px-1 text-[11px]"
              data-testid="secret-add-scope"
            >
              <option value="private">{t`Private`}</option>
              <option value="shared">{t`Shared`}</option>
            </select>
          )}
          <Button
            size="sm"
            className="h-7 text-[10px]"
            disabled={busy || !envVar.trim()}
            onClick={() => void handleAdd()}
            data-testid="secret-add-submit"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Plus className="mr-0.5 h-3 w-3" /><Trans>Add</Trans></>}
          </Button>
        </div>
      </div>
    </div>
  );
};
