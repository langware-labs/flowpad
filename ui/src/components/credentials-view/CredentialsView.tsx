import { Trans, useLingui } from '@lingui/react/macro';
import { CredentialsSubview, PageId, ViewType } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { ConnectionsManager } from '@src/components/connections-manager';
import { ProjectSelector } from '@src/components/project-selector';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useContext } from '@src/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { ChevronDown, KeyRound } from 'lucide-react';
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
  const { project: contextProject } = useContext();
  const [pickerOpen, setPickerOpen] = useState(false);

  // One surface now, so the leading tab is the only tab — and it is still
  // `credentialsTabs` that says so, keeping the URL helper the single authority
  // on where a bare `/credentials` lands. A retired subview in the pointer
  // (`environment`, `api-keys`) is forwarded here rather than 404-ing, so old
  // saved tabs and bookmarks still resolve.
  const [tab] = credentialsTabs(isHubOnly());
  const { projectId } = parseCredentialsPointer(currentDock?.pointer, tab);

  const items = useMemo(() => projectEntitiesToSelectorItems(projects), [projects]);

  // The URL wins; then the current project, so the header agrees with the
  // footer's StatusBar rather than quietly showing a different one; then the
  // head of `useProjects`, which is recency-sorted.
  const selected = useMemo(
    () =>
      (projects ?? []).find((p) => p.id === projectId) ??
      (projects ?? []).find((p) => p.id === contextProject?.id) ??
      (projects ?? [])[0],
    [projects, projectId, contextProject?.id],
  );

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

        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="ms-auto h-7 gap-1 text-xs"
                data-testid="credentials-project-picker"
              >
                {selected?.name ?? t`Select a project`}
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
