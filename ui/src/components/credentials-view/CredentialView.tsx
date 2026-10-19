import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, Check, CircleDashed, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { credentialsService, CredentialRequirement, dataContext, groupSatisfied, holdsValue, isRequired } from '@sdk';
import { credentialIcon, useCredentialState } from '@src/components/agent-resources/AgentCredentialsSection';
import { buildCredentialRows } from './credential-rows';
import { RequirementChip } from './RequirementChip';
import { CredentialDialog } from '@src/components/credentials/CredentialDialog';
import { editDraft, valuesDraft, type CredentialDraft } from '@src/components/credentials/credential-draft';
import { useCredentials } from '@src/components/credentials/use-credentials';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { CopyableCommand } from '@src/components/version-popover/version-popover';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { MarkdownView } from '@src/components/markdown-view';

/**
 * One credential — the credential editor (its asset row) and the view an agent nests for it
 * (`…/child/credential/<credential typeid>`): what it is, where its values live, and which of its
 * variables are set — read from the same status the resources menu and the Connections screen read
 * (`credentialsService.status`), picked by typeid. Values are never shown; Set values and Edit open
 * the one credential form.
 */
export function CredentialView({ typeid, onGone }: { typeid: string; onGone: () => void }) {
  const { t } = useLingui();
  const stateOf = useCredentialState();
  const projectId = dataContext.project?.typeId?.id ?? null;
  const { status, ready, refresh } = useCredentials(projectId);
  const row = useMemo(() => buildCredentialRows(status).find((r) => r.typeid === typeid) ?? null, [status, typeid]);
  const [draft, setDraft] = useState<CredentialDraft | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (!ready) return null;
  if (!row) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="credential-child-missing">
        <Trans>This credential no longer exists.</Trans>
      </div>
    );
  }

  const source = row.source;
  // An unset member of the either-or group is a warning only while NO member is set.
  const groupMet = groupSatisfied(source.vars, source.setup_choice);
  // How one variable stands — whole phrases, so a translation orders its own words.
  const words = { in: t`signed in`, out: t`not signed in`, set: t`set`, unset: t`optional · not set`, missing: t`missing` };
  const oneOfWords = { ...words, in: t`one of · signed in`, out: t`one of · not signed in`, set: t`one of · set`, unset: t`one of · not set` };
  const Icon = credentialIcon(row.iconName);
  const where = row.store === 'vault' ? t`the vault` : row.envPath || '.env.local';
  const remove = async () => {
    try {
      await credentialsService.remove(row.typeid);
      await refresh();
      notify.success({ title: t`${row.title} deleted` });
      onGone();
    } catch (error) {
      notify.error({ title: t`Could not delete ${row.title}`, message: errorMessage(error, t`It may be only partly removed.`) });
    }
  };

  return (
    <div className="h-full overflow-y-auto" data-testid="credential-child">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <header className="flex items-start gap-3">
          <Icon className="mt-1 h-6 w-6 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold" data-testid="credential-child-title">
                {row.title}
              </h1>
              <Badge variant="outline" data-testid="credential-child-scope">
                {row.scope === 'project' ? <Trans>project</Trans> : <Trans>user</Trans>}
              </Badge>
              {source.lm_provider && (
                <Badge variant="outline" data-testid="credential-child-provider">
                  <Trans>model provider · {source.lm_provider}</Trans>
                </Badge>
              )}
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  row.state === 'connected' && !row.shadowed
                    ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
                )}
                data-testid="credential-child-state"
              >
                {stateOf(row)}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{row.name}</p>
            {row.description && <p className="mt-2 text-sm text-muted-foreground">{row.description}</p>}
            {row.neededFor && (
              <p className="mt-2 text-sm" data-testid="credential-needed-for">
                <span className="text-muted-foreground">
                  <Trans>Needed for:</Trans>
                </span>{' '}
                {row.neededFor}
              </p>
            )}
            {row.justification && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground" data-testid="credential-justification">
                {row.justification}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => setDraft(valuesDraft(source))} data-testid="credential-child-set-values">
              <Trans>Set values</Trans>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDraft(editDraft(source))} data-testid="credential-child-edit">
              <Pencil className="mr-1 h-3.5 w-3.5" />
              <Trans>Edit</Trans>
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t`Delete`} onClick={() => setDeleting(true)} data-testid="credential-child-delete">
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">
            <Trans>Applies to</Trans>
          </dt>
          <dd data-testid="credential-child-applies">
            {row.scope === 'project' ? <Trans>this project's runs</Trans> : <Trans>every project, unless one declares its own</Trans>}
          </dd>
          <dt className="text-muted-foreground">
            <Trans>Values live in</Trans>
          </dt>
          <dd className="break-all font-mono text-xs" data-testid="credential-child-store">
            {where}
          </dd>
          {row.shadowed && (
            <>
              <dt className="text-muted-foreground">
                <Trans>Overridden</Trans>
              </dt>
              <dd data-testid="credential-child-shadowed">
                <Trans>The project declares the same variables; its values are the ones its runs get.</Trans>
              </dd>
            </>
          )}
        </dl>

        <section aria-labelledby="credential-vars">
          <h2 id="credential-vars" className="mb-2 text-[13px] font-semibold">
            <Trans>Variables</Trans>
          </h2>
          <ul className="divide-y rounded-md border" data-testid="credential-child-vars">
            {source.vars.map((v) => {
              const oneOf = v.required === CredentialRequirement.ONE_OF;
              // Nothing is stored for a sign-in: a tool's own (`cli`) or a grant the connection holds (`oauth`).
              const signIn = !holdsValue(v);
              const word = signIn ? (v.present ? 'in' : 'out') : v.present ? 'set' : oneOf || !isRequired(v) ? 'unset' : 'missing';
              return (
              <li key={v.env_var} className="flex items-center gap-3 px-3 py-2" data-testid={`credential-var-${v.env_var}`} data-present={v.present || undefined}>
                {v.present ? (
                  <Check className="h-4 w-4 shrink-0 text-green-600" />
                ) : isRequired(v) || (oneOf && !groupMet) ? (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" data-testid={`credential-var-alert-${v.env_var}`} />
                ) : (
                  <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px]">{v.env_var}</span>
                    <RequirementChip required={v.required} testId={`credential-var-required-${v.env_var}`} />
                  </div>
                  {v.label && v.label !== v.env_var && <div className="text-xs text-muted-foreground">{v.label}</div>}
                  {/* Nothing is stored for a cli variable: what there is to show is how to sign in. */}
                  {v.kind === 'cli' && v.login && (
                    <div className="mt-1" data-testid={`credential-var-login-${v.env_var}`}>
                      <CopyableCommand command={v.login} />
                    </div>
                  )}
                </div>
                <span className="text-xs text-muted-foreground" data-testid={`credential-var-state-${v.env_var}`}>
                  {(oneOf ? oneOfWords : words)[word]}
                  {oneOf && source.setup_choice === (v.way || v.env_var) && (
                    <span data-testid={`credential-var-chosen-${v.env_var}`}>
                      <Trans> · the way set up here</Trans>
                    </span>
                  )}
                  {!signIn && !v.secret && <Trans> · not secret</Trans>}
                </span>
                {v.warning === 'wrong-store' && (
                  <span className="text-xs text-amber-600" data-testid={`credential-var-warning-${v.env_var}`}>
                    <Trans>found in {v.found_in}, not where it is declared</Trans>
                  </span>
                )}
              </li>
              );
            })}
          </ul>
        </section>

        {(source.setup || source.help_url) && (
          <section aria-labelledby="credential-setup">
            <h2 id="credential-setup" className="mb-2 text-[13px] font-semibold">
              <Trans>How to get the values</Trans>
            </h2>
            {/* The credential's setup.md — the same guide the setup dialog shows beside each question. */}
            {source.setup && (
              <div className="text-sm text-muted-foreground" data-testid="credential-setup-guide">
                <MarkdownView value={source.setup} compact />
              </div>
            )}
            {source.help_url && (
              <a href={source.help_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
                {source.help_url}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </section>
        )}
      </div>

      {draft && (
        <CredentialDialog
          draft={draft}
          projectId={projectId}
          status={status}
          onRefresh={refresh}
          onClose={() => setDraft(null)}
          onSaved={async (saved) => {
            setDraft(null);
            await refresh();
            notify.success({ title: t`${saved.title} saved` });
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t`Delete ${row.title}?`}
        description={t`Its values are removed from where they are stored; runs that read them will no longer find them.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          setDeleting(false);
          void remove();
        }}
      />
    </div>
  );
}
