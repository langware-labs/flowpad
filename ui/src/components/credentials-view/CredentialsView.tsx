import { Trans } from '@lingui/react/macro';
import { EMPTY_CREDENTIALS_STATUS } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { ConnectionsManager } from '@src/components/connections-manager';
import { credentialDeploymentId, useCredentialsStatus } from '@src/components/credentials/use-credentials';
import { useProjects } from '@src/hooks/use-projects';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { KeyRound } from 'lucide-react';
import React, { useMemo } from 'react';

import { credentialsTabs, parseCredentialsPointer } from './credentials-pointer';
import { EnvFilesChip } from './EnvFilesChip';
import { LoginRequiredPanel } from './LoginRequiredPanel';

/**
 * Credentials — the one surface for everything a project or a person
 * authenticates with: OAuth connections, API credentials, and bare declared
 * environment variables, all as rows of one table.
 *
 * The project lives in the pointer, never in local state — a reload lands where
 * you were. There is no picker here: the project is the one already selected in
 * the app, which `navigation.openCredentials` — every way in — puts in the URL.
 */
export const CredentialsView: React.FC = () => {
  const { user } = useAuth();
  const { currentDock } = useDockNavigation();
  const { projects } = useProjects();

  // One surface now, so the leading tab is the only tab — and it is still
  // `credentialsTabs` that says so, keeping the URL helper the single authority
  // on where a bare `/credentials` lands. A retired subview in the pointer
  // (`environment`, `api-keys`) is forwarded here rather than 404-ing, so old
  // saved tabs and bookmarks still resolve.
  const [tab] = credentialsTabs(isHubOnly());
  const { projectId } = parseCredentialsPointer(currentDock?.pointer, tab);

  // An unscoped URL manages the person's credentials. Falling back to a
  // recent/context project silently turns Test into a project permission check
  // and grants new connections to a project the URL does not name.
  const selected = useMemo(
    () => (projects ?? []).find((p) => p.id === projectId),
    [projects, projectId],
  );

  // The env files the table reads, for the chip. The table's own status entry,
  // so this is the cached status, not a second fetch.
  const { data: status = EMPTY_CREDENTIALS_STATUS } = useCredentialsStatus(
    selected?.id ?? null,
    credentialDeploymentId(currentDock),
  );

  if (!user?.id) {
    // One guard for the whole view rather than three near-identical ones.
    return <LoginRequiredPanel message={<Trans>Please log in to view and manage credentials.</Trans>} />;
  }

  return (
    <div className="flex h-full flex-col" data-testid="credentials-view">
      {/* Fixed height: the chip is taller than the title, so an auto-height
          header would jump when it renders. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <KeyRound className="h-4 w-4" />
        <h2 className="text-sm font-semibold">
          <Trans>Credentials</Trans>
        </h2>

        <EnvFilesChip status={status} project={selected} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ConnectionsManager projectTypeId={selected?.typeId} project={selected} header={false} />
      </div>
    </div>
  );
};
