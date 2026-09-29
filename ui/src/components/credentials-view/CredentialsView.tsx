import { Trans, useLingui } from '@lingui/react/macro';
import { CredentialsSubview, PageId, ViewType } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { CREDENTIAL_DEPLOYMENT_OPTION, ConnectionsManager } from '@src/components/connections-manager';
import { useCredentials } from '@src/components/credentials/use-credentials';
import { ProjectSelector } from '@src/components/project-selector';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useProjects } from '@src/hooks/use-projects';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { ChevronDown, FileKey, KeyRound } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { credentialsPointer, credentialsTabs, parseCredentialsPointer } from './credentials-pointer';
import { LoginRequiredPanel } from './LoginRequiredPanel';

/**
 * Credentials — the one surface for everything a project or a person
 * authenticates with: OAuth connections, API credentials, and bare declared
 * environment variables, all as rows of one table.
 *
 * Page-agnostic on purpose. It reads `currentDock.page` rather than hardcoding
 * the hub, so mounting it on the desk keeps working; `openPage` is what
 * preserves that (`openTab` is desk-only and would silently revert the page).
 *
 * Project selection lives in the pointer, never in local state — a reload lands
 * where you were, and picking a project is a navigation rather than a hidden
 * write.
 */
export const CredentialsView: React.FC = () => {
  const { t } = useLingui();
  const { user } = useAuth();
  const { navigation, currentDock } = useDockNavigation();
  const { projects, isLoading } = useProjects();
  const [pickerOpen, setPickerOpen] = useState(false);

  // One surface now, so the leading tab is the only tab — and it is still
  // `credentialsTabs` that says so, keeping the URL helper the single authority
  // on where a bare `/credentials` lands. A retired subview in the pointer
  // (`environment`, `api-keys`) is forwarded here rather than 404-ing, so old
  // saved tabs and bookmarks still resolve.
  const [tab] = credentialsTabs(isHubOnly());
  const { projectId } = parseCredentialsPointer(currentDock?.pointer, tab);

  const items = useMemo(() => projectEntitiesToSelectorItems(projects), [projects]);

  // An unscoped URL manages the person's credentials. Falling back to a
  // recent/context project silently turns Test into a project permission check
  // and grants new connections to a project the user never selected here.
  const selected = useMemo(
    () => (projects ?? []).find((p) => p.id === projectId),
    [projects, projectId],
  );

  // The env files the table reads, as chips — only those on disk. Same query key
  // as the table's, so this is the cached status, not a second fetch.
  const { status } = useCredentials(
    selected?.id ?? null,
    currentDock?.options?.[CREDENTIAL_DEPLOYMENT_OPTION] || null,
  );
  const envFiles = status.files.filter((file) => file.exists && file.path);

  const go = (nextTab: CredentialsSubview, nextProjectId?: string) => {
    navigation.openPage(
      currentDock?.page ?? PageId.DESK,
      ViewType.CREDENTIALS,
      credentialsPointer(nextTab, nextProjectId ?? selected?.id),
    );
  };

  if (!user?.id) {
    // One guard for the whole view rather than three near-identical ones.
    return <LoginRequiredPanel message={<Trans>Please log in to view and manage credentials.</Trans>} />;
  }

  return (
    <div className="flex h-full flex-col" data-testid="credentials-view">
      {/* Fixed height: the picker is taller than the title, so an auto-height
          header would jump 4px when it renders. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <KeyRound className="h-4 w-4" />
        <h2 className="text-sm font-semibold">
          <Trans>Credentials</Trans>
        </h2>

        {envFiles.map((file) => (
          <Button
            key={file.path}
            variant="outline"
            size="sm"
            className="h-6 gap-1 rounded-full px-2 font-mono text-[11px] font-normal"
            title={file.path ?? undefined}
            onClick={() => navigation.openMachinePath(file.path!, LOCAL_COMPUTE_NODE)}
            data-testid={`credentials-env-file-${file.scope}`}
          >
            <FileKey className="h-3 w-3" />
            {file.path!.split(/[\\/]/).pop()}
          </Button>
        ))}

        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="ms-auto h-7 gap-1 text-xs"
                data-testid="credentials-project-picker"
              >
                {selected?.displayName ?? selected?.name ?? t`Select a project`}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="end">
              <div className="max-h-80 min-h-0">
                <ProjectSelector
                  projects={items}
                  selectedId={selected?.id ?? null}
                  isLoading={isLoading}
                  emptyMessage={t`No projects yet`}
                  onSelect={(id) => {
                    setPickerOpen(false);
                    if (id) go(tab, id);
                  }}
                />
              </div>
            </PopoverContent>
        </Popover>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ConnectionsManager projectTypeId={selected?.typeId} project={selected} header={false} />
      </div>
    </div>
  );
};
