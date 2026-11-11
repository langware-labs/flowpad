import { t } from '@lingui/core/macro';
import type { Project } from '@sdk';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';

/**
 * Ask before deleting a project. The folder on disk holds the user's own files,
 * so removing it is a separate, opt-in choice (off by default); chat history is
 * deleted by default because keeping it can make the project reappear on a scan.
 */
export function confirmProjectDelete(
  project: Pick<Project, 'displayName' | 'fs_storage_mount_path' | 'deleteWithChildren'>,
  onDeleted: () => void,
): void {
  const mount = project.fs_storage_mount_path;
  // An LTR isolate keeps the path's slashes in place inside RTL (he/ar) text.
  const path = mount ? `⁦${mount}⁩` : undefined;
  showDeleteAssetModal({
    name: project.displayName ?? t`this project`,
    description: t`This permanently deletes the project and everything in it — all indexed records and their children. This cannot be undone.`,
    checkboxes: [
      {
        key: 'chats',
        label: t`Delete chats`,
        description: t`Keeping chat history can make this project reappear when projects are scanned.`,
        defaultChecked: true,
      },
      {
        key: 'folder',
        label: t`Also delete the project folder from my computer`,
        description: path
          ? t`Removes ${path} and every file in it.`
          : t`Removes the project folder and every file in it.`,
        warning: t`All local files in this folder, including uncommitted Git changes, will be permanently deleted. This cannot be undone.`,
        defaultChecked: false,
      },
    ],
    confirmLabel: (checked) => (checked.folder ? t`Remove Project & Delete Files` : t`Remove Project`),
    onConfirm: async (checked) => {
      await project.deleteWithChildren({ deleteChats: checked.chats, deleteFolder: checked.folder });
    },
    onAfterDelete: onDeleted,
  });
}
