import * as React from 'react';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { CredentialDialog } from './CredentialDialog';
import { customDraft } from './credential-draft';
import { useCredentials } from './use-credentials';

/**
 * The quick-create "Credentials" tile: the same dialog, the same save as
 * Connections → Add connection → Custom credentials.
 */
export const CredentialQuickCreateDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string | null;
}> = ({ open, onOpenChange, projectId = null }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { status, refresh } = useCredentials(projectId);
  // A new draft per open, so the form starts clean each time.
  const draft = React.useMemo(() => (open ? customDraft(projectId ? 'project' : 'user') : null), [open, projectId]);

  if (!draft) return null;
  return (
    <CredentialDialog
      draft={draft}
      projectId={projectId}
      status={status}
      onRefresh={refresh}
      onClose={() => onOpenChange(false)}
      onSaved={async (saved) => {
        onOpenChange(false);
        await refresh();
        notify.success({ title: t`${saved.title} added` });
        navigation.openDock(DockPointer.forCredentials(undefined, saved.project_id ?? undefined));
      }}
    />
  );
};
