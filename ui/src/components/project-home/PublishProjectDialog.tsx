import { useEffect } from 'react';
import { Trans } from '@lingui/react/macro';
import type { Project } from '@sdk';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useEntity } from '@src/hooks/entity-hooks';
import { ProjectCloudLinkButton } from './ProjectCloudLinkButton';

interface PublishProjectDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Shown INSTEAD of an invite surface while a Project has no hub row.
 *
 * Inviting is a membership grant on that row (`Project.share(users)` → the
 * `members` action), so until the Project is published there is nothing to
 * grant on. Publishing is its own step with its own checks, owned by
 * `ProjectCloudLinkButton`; this only puts it in front of the invite. Closes
 * itself once the Project is published, so the next Invite goes straight through.
 */
export function PublishProjectDialog({ project, open, onOpenChange }: PublishProjectDialogProps) {
  // Live row, not the prop: publishing flips `remote` through the store.
  const { data } = useEntity<Project>(project.typeId);
  const live = data ?? project;
  const published = live.remote === true;
  const name = live.displayName || live.name || 'this project';

  useEffect(() => {
    if (open && published) onOpenChange(false);
  }, [open, published, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="publish-project-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Project not published</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Publish {name} to the cloud before inviting people — invitees get the project from there.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <ProjectCloudLinkButton project={live} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
