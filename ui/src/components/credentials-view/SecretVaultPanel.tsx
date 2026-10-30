import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, CloudDownload, CloudUpload, KeyRound } from 'lucide-react';
import { Credential, credentialsService } from '@sdk';
import { AskForHelpDialog } from '@src/components/help/AskForHelpDialog';
import { Button } from '@src/components/ui/button';
import { describeApiError } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/** Why a fetch did not fill the values — the codes `credentials/fetch` answers or refuses with. */
type Blocked =
  | { kind: 'denied'; vaults: string[] }
  | { kind: 'needs_connection' | 'unknown_vault' | 'missing'; vaults?: string[] }
  | null;

/** One stored variable and the vault its value is shared through (`secret_ref`); null — none yet. */
export interface VarVaultRef {
  env_var: string;
  vault: string | null;
}

/**
 * A credential's values travel between people ONLY through the project's vaults
 * (`secret_vaults` in project_manifest.json, docs/secret_share.md). This panel is the credential's
 * side of that:
 *
 * - lists the project's vaults and each stored variable's vault;
 * - values missing here, the project has vaults → Fetch (into this computer's store); a denied
 *   vault → Request access (a `secret_access_request` reply to whoever shared it);
 * - values missing here, no vault → receiving needs one: Report, through ask-for-help;
 * - values here, the project has vaults → Publish (into the first vault).
 */
export function SecretVaultPanel({
  credentialId,
  name,
  title,
  projectId,
  projectName,
  vaults,
  refs,
  missing,
  onChanged,
}: {
  credentialId: string;
  name: string;
  title: string;
  projectId: string | null;
  projectName: string;
  /** The project's vault names. */
  vaults: string[];
  refs: VarVaultRef[];
  /** This computer lacks a value the credential holds. */
  missing: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<Blocked>(null);
  const [requested, setRequested] = useState<string[]>([]);
  const [asking, setAsking] = useState<null | { title: string; notes: string }>(null);
  if (!projectId) return null;

  const fetchValues = async () => {
    setBusy(true);
    try {
      const res = await credentialsService.fetch(name, projectId);
      if (res.denied.length) setBlocked({ kind: 'denied', vaults: res.denied });
      else setBlocked(res.missing.length ? { kind: 'missing' } : null);
      if (res.fetched.length) notify.success({ title: t`${title}: fetched from the vault` });
      await onChanged();
    } catch (error) {
      const { code, message } = describeApiError(error, t`Could not fetch the values`);
      const used = [...new Set(refs.map((r) => r.vault).filter((v): v is string => !!v))];
      if (code === 'denied') setBlocked({ kind: 'denied', vaults: used.length ? used : vaults });
      else if (code === 'needs_connection' || code === 'unknown_vault') setBlocked({ kind: code });
      else notify.error({ title: t`Could not fetch ${title}`, message });
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    const vault = refs.find((r) => r.vault)?.vault ?? vaults[0];
    if (!vault) return;
    setBusy(true);
    try {
      const res = await credentialsService.publish(name, projectId, vault);
      notify.success({ title: t`${title}: shared through vault ${vault}`, message: res.published.join(', ') });
      await onChanged();
    } catch (error) {
      notify.error({ title: t`Could not publish ${title}`, message: describeApiError(error, t`It was not written.`).message });
    } finally {
      setBusy(false);
    }
  };

  const requestAccess = async (vault: string) => {
    setBusy(true);
    try {
      await new Credential({ id: credentialId } as never).requestSecretAccess(vault);
      setRequested((r) => [...r, vault]);
      notify.success({ title: t`Access to vault ${vault} requested` });
    } catch (error) {
      // Not received through a conversation: ask through the one ask-for-help path instead.
      const { message } = describeApiError(error, '');
      setAsking({
        title: t`Access to ${projectName} vault ${vault}`,
        notes: t`Please give me read access to vault ${vault} of ${projectName}, so I can fetch ${title}.` + (message ? `\n\n${message}` : ''),
      });
    } finally {
      setBusy(false);
    }
  };

  const ask = asking && (
    <AskForHelpDialog
      open
      onOpenChange={(open) => !open && setAsking(null)}
      projectId={projectId}
      origin="credential"
      initialTitle={asking.title}
      initialNotes={asking.notes}
      onAsked={() => setAsking(null)}
    />
  );

  if (!vaults.length) {
    if (!missing) return null;
    return (
      <section className="rounded-md border border-destructive/40 px-3 py-3" data-testid="credential-vault-none">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">
              <Trans>Receiving secrets requires a secret manager vault on the project.</Trans>
            </p>
            <p className="mt-1 text-muted-foreground">
              <Trans>{projectName} has none, so its values have nowhere to come from.</Trans>
            </p>
          </div>
          <Button
            size="sm"
            onClick={() =>
              setAsking({
                title: t`${projectName} has no secret manager`,
                notes: t`I received the ${title} credential, but ${projectName} has no secret manager vault to fetch its values from. Please set one up on the project.`,
              })
            }
            data-testid="credential-vault-report"
          >
            <Trans>Report</Trans>
          </Button>
        </div>
        {ask}
      </section>
    );
  }

  const denied = blocked?.kind === 'denied' ? blocked.vaults : [];
  return (
    <section className="rounded-md border px-3 py-3" data-testid="credential-vault">
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-sm">
          <p>
            <Trans>
              Shared through the project's vaults: <span className="font-mono text-xs">{vaults.join(', ')}</span>
            </Trans>
          </p>
          <ul className="mt-1 text-xs text-muted-foreground" data-testid="credential-vault-refs">
            {refs.map((r) => (
              <li key={r.env_var}>
                <span className="font-mono">{r.env_var}</span> →{' '}
                {r.vault ? <span className="font-mono">{r.vault}</span> : <Trans>not in a vault yet</Trans>}
              </li>
            ))}
          </ul>
          {denied.length > 0 && (
            <p className="mt-1 text-destructive" data-testid="credential-vault-denied">
              <Trans>You have no access to vault {denied.join(', ')} yet.</Trans>
            </p>
          )}
          {blocked?.kind === 'needs_connection' && (
            <p className="mt-1 text-destructive" data-testid="credential-vault-signin">
              <Trans>Sign in to the secret manager first (the project setup), then fetch again.</Trans>
            </p>
          )}
          {blocked?.kind === 'unknown_vault' && (
            <p className="mt-1 text-destructive" data-testid="credential-vault-unknown">
              <Trans>A variable points at a vault the project does not declare.</Trans>
            </p>
          )}
          {blocked?.kind === 'missing' && (
            <p className="mt-1 text-muted-foreground" data-testid="credential-vault-missing">
              <Trans>The vault holds no value for it yet — ask the owner to publish it.</Trans>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          {missing ? (
            <>
              {denied.map((vault) =>
                requested.includes(vault) ? (
                  <span key={vault} className="text-xs text-muted-foreground" data-testid="credential-vault-requested">
                    <Trans>Requested</Trans>
                  </span>
                ) : (
                  <Button
                    key={vault}
                    size="sm"
                    disabled={busy}
                    onClick={() => void requestAccess(vault)}
                    data-testid="credential-vault-request"
                  >
                    <Trans>Request access</Trans>
                  </Button>
                ),
              )}
              <Button
                size="sm"
                variant={denied.length ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => void fetchValues()}
                data-testid="credential-vault-fetch"
              >
                <CloudDownload className="mr-1 h-3.5 w-3.5" />
                <Trans>Fetch</Trans>
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void publish()} data-testid="credential-vault-publish">
              <CloudUpload className="mr-1 h-3.5 w-3.5" />
              <Trans>Publish</Trans>
            </Button>
          )}
        </div>
      </div>
      {ask}
    </section>
  );
}
