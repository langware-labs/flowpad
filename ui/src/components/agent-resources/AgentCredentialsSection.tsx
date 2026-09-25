import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { dataContext, credentialsService, type SecretPack } from '@sdk';
import { NavigatorSection } from '@src/components/navigator-panel/NavigatorSection';
import { AddConnectionDialog } from '@src/components/connections-manager/add-connection-dialog';
import { buildCredentialRows, type CredentialRow } from '@src/components/credentials-view/credential-rows';
import { CredentialDialog } from '@src/components/credentials/CredentialDialog';
import { customDraft, templateDraft, type CredentialDraft } from '@src/components/credentials/credential-draft';
import { useCredentials } from '@src/components/credentials/use-credentials';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { lucideByName } from '@src/lib/lucide-by-name';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Empty, IconButton, ResourceRow } from './parts';

/** A credential's glyph: its definition's `icon_name` (asset data), else a key. */
export function credentialIcon(iconName?: string) {
  return (iconName && lucideByName(iconName)) || KeyRound;
}

/** How a credential stands, for its row and its page: set, what is missing, or overridden. */
export function useCredentialState() {
  const { t } = useLingui();
  return (row: CredentialRow): string =>
    row.shadowed
      ? t`overridden by the project's`
      : row.state === 'connected'
        ? t`set`
        : t`${row.missing.length} missing`;
}

/**
 * The credentials this agent's runs resolve — the project's, then the user's (a worker gets the
 * project's over the user's) — in the resources menu. Read through the Connections screen's own
 * status (`useCredentials` → `credentialsService.status`), so the two cannot disagree. A row opens
 * the credential nested in the agent editor; `+` declares one with the same picker and form.
 */
export function AgentCredentialsSection() {
  const { t } = useLingui();
  const stateOf = useCredentialState();
  const { navigation, currentDock } = useDockNavigation();
  // The project the pane rides, as the MCP / Skills / Docs sections beside this one read it.
  const projectId = dataContext.project?.typeId?.id ?? null;
  const { status, templates, ready, refresh } = useCredentials(projectId);
  const rows = useMemo(() => buildCredentialRows(status), [status]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<CredentialDraft | null>(null);
  const [deleting, setDeleting] = useState<CredentialRow | null>(null);

  const scope = projectId ? 'project' : 'user';
  const addable = useMemo(() => {
    const declared = new Set(rows.map((r) => r.name));
    return templates.filter((spec) => !declared.has(String(spec.name ?? '')));
  }, [rows, templates]);

  const remove = async (row: CredentialRow) => {
    try {
      await credentialsService.remove(row.typeid);
      await refresh();
      notify.success({ title: t`${row.title} deleted` });
    } catch (error) {
      notify.error({ title: t`Could not delete ${row.title}`, message: errorMessage(error, t`It may be only partly removed.`) });
    }
  };

  return (
    <>
      <NavigatorSection
        scope="agent-resources"
        id="credentials"
        label={t`Credentials`}
        isLoading={!ready}
        itemCount={rows.length}
        action={<IconButton icon={Plus} label={t`Add credential`} onClick={() => setAdding(true)} testId="agent-resource-add-credential" />}
        emptyState={
          <Empty>
            <Trans>Keys and tokens this agent's runs can read</Trans>
          </Empty>
        }
      >
        {rows.map((row) => (
          <ResourceRow
            key={row.typeid}
            icon={credentialIcon(row.iconName)}
            label={row.title}
            detail={`${row.scope} · ${stateOf(row)}`}
            selected={currentDock?.child?.typeId === row.typeid}
            // Opens nested in the agent editor (see DockPointer.child); a click only navigates.
            onOpen={() => currentDock && navigation.openDock(currentDock.withChild('credential', row.typeid))}
            testId={`agent-resource-credential-${row.scope}-${row.name}`}
            action={
              <IconButton
                icon={Trash2}
                label={t`Delete ${row.title}`}
                onClick={() => setDeleting(row)}
                testId={`agent-resource-delete-credential-${row.scope}-${row.name}`}
              />
            }
          />
        ))}
      </NavigatorSection>

      <AddConnectionDialog
        open={adding}
        onOpenChange={setAdding}
        providers={[]}
        specs={addable}
        onPickProvider={() => undefined}
        onPickCredential={(spec: SecretPack) => {
          setAdding(false);
          setDraft(templateDraft(spec, scope));
        }}
        onPickCustom={() => {
          setAdding(false);
          setDraft(customDraft(scope));
        }}
      />
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
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t`Delete ${deleting?.title ?? ''}?`}
        description={t`Its values are removed from where they are stored; runs that read them will no longer find them.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row) void remove(row);
        }}
      />
    </>
  );
}
