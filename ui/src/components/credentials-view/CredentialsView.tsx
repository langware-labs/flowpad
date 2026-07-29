import { Trans, useLingui } from '@lingui/react/macro';
import { CredentialsSubview, PageId, ViewType } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { ApiKeysView } from '@src/components/api-keys-view/api-keys-view';
import { ConnectionsManager } from '@src/components/connections-manager';
import { EnvVarsManager } from '@src/components/EnvVarsManager';
import { ProjectSelector } from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useContext } from '@src/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ChevronDown, KeyRound } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { credentialsPointer, parseCredentialsPointer } from './credentials-pointer';
import { LoginRequiredPanel } from './LoginRequiredPanel';

/**
 * Credentials — one surface over the three things a project or a person needs
 * to authenticate: environment variables, OAuth connections, and API keys.
 *
 * Page-agnostic on purpose. It reads `currentDock.page` rather than hardcoding
 * the hub, so mounting it on the desk keeps working; `openPage` is what
 * preserves that (`openTab` is desk-only and would silently revert the page).
 *
 * Tab AND project selection live in the pointer, never in local state — a
 * reload lands where you were, and picking a project is a navigation rather
 * than a hidden write.
 */
export const CredentialsView: React.FC = () => {
  const { t } = useLingui();
  const { user } = useAuth();
  const { navigation, currentDock } = useDockNavigation();
  const { projects, isLoading } = useProjects();
  const { project: contextProject } = useContext();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { tab, projectId } = parseCredentialsPointer(currentDock?.pointer);

  const items = useMemo(
    () =>
      (projects ?? []).map((p) => ({
        id: p.id,
        name: p.name || p.id,
        path: p.fs_storage_mount_path ?? '',
        modifiedAt: null,
        recencyMs: 0,
      })),
    [projects],
  );

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
    return (
      <LoginRequiredPanel message={<Trans>Please log in to view and manage credentials.</Trans>} />
    );
  }

  const showPicker = tab !== CredentialsSubview.API_KEYS;

  return (
    <div className="flex h-full flex-col" data-testid="credentials-view">
      {/* Fixed height: the picker is taller than the title and is hidden on API
          Keys, so an auto-height header would jump 4px on every tab switch. */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <KeyRound className="h-4 w-4" />
        <h2 className="text-sm font-semibold">
          <Trans>Credentials</Trans>
        </h2>

        {showPicker && (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="ml-auto h-7 gap-1 text-xs" data-testid="credentials-project-picker">
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
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => go(v as CredentialsSubview)} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b px-2">
          <TabsList className="h-8">
            <TabsTrigger value={CredentialsSubview.ENVIRONMENT} className="h-7 text-xs">
              <Trans>Environment</Trans>
            </TabsTrigger>
            <TabsTrigger value={CredentialsSubview.CONNECTIONS} className="h-7 text-xs">
              <Trans>Connections</Trans>
            </TabsTrigger>
            <TabsTrigger value={CredentialsSubview.API_KEYS} className="h-7 text-xs">
              <Trans>API Keys</Trans>
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {tab === CredentialsSubview.ENVIRONMENT &&
            (selected ? (
              <EnvVarsManager entityTypeId={selected.typeId} header={false} />
            ) : (
              <NoProjectPanel loading={isLoading} />
            ))}

          {tab === CredentialsSubview.CONNECTIONS && (
            <ConnectionsManager projectTypeId={selected?.typeId} header={false} />
          )}

          {tab === CredentialsSubview.API_KEYS && <ApiKeysView header={false} className="max-w-4xl" />}
        </div>
      </Tabs>
    </div>
  );
};

const NoProjectPanel: React.FC<{ loading?: boolean }> = ({ loading }) => (
  <div className="p-4 text-sm text-muted-foreground" data-testid="credentials-no-project">
    {loading ? (
      <Trans>Loading projects…</Trans>
    ) : (
      // No create button: making a project is a local-filesystem flow, which
      // cannot work from a hub-only server.
      <Trans>No projects yet — create one from the desktop app, then pick it here.</Trans>
    )}
  </div>
);
