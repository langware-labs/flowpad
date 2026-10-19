import { Settings } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { dataContext } from '@sdk';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useClaudeSettings } from '@src/hooks/useClaudeSettings';
import { ClaudeSettingsPanel } from './ClaudeSettingsPanel';

export function SettingsView() {
  const computeNodeId = dataContext.computeNode?.id;
  const projectDir = dataContext.project?.fs_storage_mount_path;
  const { currentDock } = useDockNavigation();

  // Read initial filter from URL: ?filter=search_string
  const initialFilter = currentDock?.options?.filter ?? '';
  // Read field name from pointer: /dock/settings/<field_name>
  const initialFieldName = currentDock?.pointer ?? '';

  const { userRecords, projectRecords, localRecords, isLoading, error } =
    useClaudeSettings(computeNodeId, projectDir ?? undefined, true);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl space-y-6 p-6">
          {/* Header */}
          <div>
            <div className="flex items-center gap-2">
              <Settings className="h-6 w-6" />
              <h2 className="text-2xl font-bold text-foreground"><Trans>Settings</Trans></h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans>View Claude Code settings across user, project, and local scopes</Trans>
            </p>
          </div>

          {/* Loading / error states */}
          {isLoading ? (
            <div className="flex items-center justify-center rounded-lg border p-12">
              <p className="text-sm text-muted-foreground"><Trans>Loading settings...</Trans></p>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          ) : (
            <ClaudeSettingsPanel
              userRecords={userRecords}
              projectRecords={projectRecords}
              localRecords={localRecords}
              initialFilter={initialFilter}
              initialFieldName={initialFieldName}
            />
          )}
        </div>
      </div>
    </div>
  );
}
