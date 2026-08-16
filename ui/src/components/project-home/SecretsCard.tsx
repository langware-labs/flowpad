import { Trans, useLingui } from '@lingui/react/macro';
import type { Project, SecretOriginLocator } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { ProvideValueInline } from '@src/components/credentials-view/ProvideValueInline';
import { useSecretOriginLabel } from '@src/components/secrets/OriginChip';
import { SECRET_ORIGIN_KINDS, originKindSpec } from '@src/components/secrets/secret-origin-kinds';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useProjectSecretOrigins } from '@src/hooks/use-project-secret-origins';
import { Check, KeyRound, Loader2, Plus, TriangleAlert, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';

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
  const originLabel = useSecretOriginLabel();
  const { secretOrigins, status, add, provide, remove } = useProjectSecretOrigins(project);

  const statusByTypeId = useMemo(() => new Map(status.map((s) => [s.typeid, s])), [status]);

  const [busy, setBusy] = useState(false);
  const [wizardFor, setWizardFor] = useState<string | null>(null);

  // Add form
  const [envVar, setEnvVar] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SecretOriginLocator['kind']>('local');
  const [coord, setCoord] = useState('');
  const [scope, setScope] = useState<'private' | 'shared'>('private');

  // The kind table is shared with the Credentials screen's Project Environment
  // tab — one table so the two surfaces cannot disagree about where a kind's
  // coordinate lives or which store holds its value.
  const provider = originKindSpec(kind) ?? SECRET_ORIGIN_KINDS[0];

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
      notify.error({ title: t`Error`, message: errorMessage(e, t`Failed to add secret`) });
    } finally {
      setBusy(false);
    }
  };

  // ProvideValueInline owns the input and its busy state; this only routes the
  // value and decides that a success closes the wizard.
  const handleProvide = async (typeid: string, value: string) => {
    try {
      await provide({ typeid, value });
      setWizardFor(null);
    } catch (e) {
      notify.error({ title: t`Error`, message: errorMessage(e, t`Failed to store value`) });
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
                    className={`ms-auto flex items-center gap-0.5 text-[10px] ${available ? 'text-green-600' : 'text-amber-600'}`}
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
                      <ProvideValueInline
                        envVar={s.env_var}
                        prompt={st?.setup_hint?.prompt}
                        onSubmit={(value) => handleProvide(s.typeid, value)}
                        onCancel={() => setWizardFor(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setWizardFor(s.typeid)}
                        className="text-[10px] text-primary hover:underline"
                        data-testid={`secret-setup-${s.env_var}`}
                      >
                        {comingSoon ? st?.setup_hint?.prompt || t`Set up` : <Trans>Set up →</Trans>}
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
            {/* Every kind, not just OFFERED_ORIGIN_KINDS: this card has always
                listed the stub-driver kinds (gcp, 1password) and narrowing it
                here would quietly retire them. The declare dialog on the
                Credentials screen offers only the working ones — worth
                reconciling, but that is a product call, not a cleanup. */}
            {SECRET_ORIGIN_KINDS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {originLabel(p.kind)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={coord}
            onChange={(e) => setCoord(e.target.value)}
            placeholder={provider.coordField}
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
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <Plus className="me-0.5 h-3 w-3" />
                <Trans>Add</Trans>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};
