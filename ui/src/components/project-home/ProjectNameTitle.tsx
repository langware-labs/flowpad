import { dataManager, type Project } from '@sdk';
import { EditableTitle } from '@src/components/organization/budgets/EditableTitle';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { useCallback } from 'react';
import { useLingui } from '@lingui/react/macro';

/**
 * The project's name on its home, editable in place (click → input; Enter or
 * blur commits, Escape cancels).
 *
 * A rename is an ordinary `project.save()`. Where it lands is decided by the
 * save path, not here: a local project updates its own row; a cloud-linked one
 * (`remote`) saves with `Hub-Reflect`, so the backend PUTs the name to the hub
 * and mirrors the hub's answer back — a hub refusal comes back as an error and
 * the name reverts rather than drifting from the cloud copy.
 */
export function ProjectNameTitle({ project }: { project: Project }) {
  const { t } = useLingui();

  const onRename = useCallback(
    async (next: string) => {
      const previous = project.name;
      project.name = next;
      try {
        await project.save();
      } catch (error) {
        // A failed save does not roll back the cached row, and an in-place revert
        // notifies no one — re-fetch so every surface drops the refused name.
        project.name = previous;
        notify.error({ title: t`Could not rename project`, message: errorMessage(error, t`Rename failed.`) });
        void dataManager.refreshByTypeId(project.typeId).catch(() => null);
      }
    },
    [project, t],
  );

  // Renaming is not permission-gated here: the hub is the authority for a
  // cloud-linked project and answers a refused rename with an error.
  return (
    <EditableTitle
      name={project.displayName}
      onRename={onRename}
      manage
      headingClassName="text-sm font-medium"
      testIdPrefix="project"
    />
  );
}
