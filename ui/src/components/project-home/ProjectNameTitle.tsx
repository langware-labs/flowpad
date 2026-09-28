import { dataManager, type Project } from '@sdk';
import { InlineRenameInput } from '@src/components/browseable-tree/InlineRenameInput';
import { useInlineRename } from '@src/components/browseable-tree/use-inline-rename';
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
  const name = project.displayName;

  const onRename = useCallback(
    async (next: string) => {
      const previous = project.name;
      project.name = next;
      try {
        await project.save();
      } catch (error) {
        project.name = previous;
        // Re-fetch so every surface holding the cached row drops the refused name.
        await dataManager.refreshByTypeId(project.typeId).catch(() => null);
        notify.error({ title: t`Could not rename project`, message: errorMessage(error, t`Rename failed.`) });
      }
    },
    [project, t],
  );
  const rename = useInlineRename(name, onRename);

  const textClass = 'text-sm font-medium';
  return rename.editing ? (
    <InlineRenameInput
      rename={rename}
      className={`min-w-0 rounded-md border border-border bg-background px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring ${textClass}`}
      testId="project-name-input"
      ariaLabel={t`Project name`}
    />
  ) : (
    <button
      type="button"
      className={`truncate rounded px-1 py-0.5 text-left hover:bg-muted ${textClass}`}
      title={t`Rename project`}
      data-testid="project-name"
      onClick={rename.startEditing}
    >
      {name}
    </button>
  );
}
