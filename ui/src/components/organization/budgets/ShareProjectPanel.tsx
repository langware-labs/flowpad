/**
 * Handing a project to a whole team, from the People & teams page.
 *
 * The page's other share control (`OrgSharePanel`) hands someone the
 * ORGANIZATION. This hands the team a piece of WORK: pick one project and the
 * TEAM itself is granted it on the hub, at `member` — one group grant, not one
 * invite per person — so everyone on the team, today and later, has it. The
 * sharer's client also opens one invite conversation granted to the team, whose
 * message carries the project's Install chip. Nobody has to accept anything.
 *
 * **What actually travels.** The project must already be published — an
 * unpublished one gets the publish popup instead of this dialog — and sharing is
 * then one group grant (`Project.invite([], { teams })` → the `share` action).
 * The published row carries its metadata — its `locale`, so a recipient opens it
 * in the language its author works in — and its shared context and secret
 * DECLARATIONS. Its published assets live in the project's hub-hosted
 * repository, which every member reaches with their own hub login.
 *
 * **Nothing here runs the publish rules.** They guard publishing (the popup's
 * `ProjectCloudLinkButton`), not an invite to a Project that is already published.
 */
import { TypeId, type Project } from '@sdk';
import { FolderGit2, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { ProjectPickerModal } from '@src/components/assets/ProjectPickerModal';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { useEntity } from '@src/hooks/entity-hooks';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { getProjectDisplayName } from '@src/hooks/use-claude-projects';
import { PublishProjectDialog } from '@src/components/project-home/PublishProjectDialog';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/** The header control. Rendered where the hub says the caller may run this team. */
export function ShareProjectButton({ teamId, teamName }: { teamId: string; teamName: string }) {
  const { t } = useLingui();
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);

  // The projects being shared are on the SENDER's machine — the picker lists
  // them from the local compute node. The hub runtime has none, so the same People & teams page rendered there
  // must not offer a control that could only ever come up empty.
  if (isHubOnly()) return null;

  return (
    <>
      <Button size="sm" variant="outline" data-testid={`team-share-project-${teamId}`} onClick={() => setPicking(true)}>
        <FolderGit2 className="h-4 w-4" />
        <Trans>Share project</Trans>
      </Button>

      <ProjectPickerModal
        open={picking}
        onOpenChange={setPicking}
        selectedIds={[]}
        singleSelect
        confirmLabel={t`Choose`}
        description={<Trans>Everyone in {teamName} will get the project you pick.</Trans>}
        onConfirm={(_ids, items) => {
          const picked = items[0];
          if (!picked) return;
          setChosen({ id: picked.id, name: getProjectDisplayName(picked) });
          setPicking(false);
        }}
      />

      {chosen && (
        <ShareProjectDialog
          teamId={teamId}
          teamName={teamName}
          projectId={chosen.id}
          projectName={chosen.name}
          onClose={() => setChosen(null)}
        />
      )}
    </>
  );
}

function ShareProjectDialog({
  teamId,
  teamName,
  projectId,
  projectName,
  onClose,
}: {
  teamId: string;
  teamName: string;
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const projectTypeId = useMemo(() => new TypeId('project', projectId), [projectId]);
  const { data: project } = useEntity<Project>(projectTypeId);

  const [sharing, setSharing] = useState(false);

  const share = useCallback(async () => {
    if (!project || sharing) return;
    setSharing(true);
    try {
      // One group grant for the whole team; the backend also opens the team's
      // invite conversation. The outcome is per team, never a throw.
      const result = await project.invite([], { teams: [new TypeId('team', teamId)] });
      const failed = result.failed_teams?.[0];
      if (failed) {
        notify.error({
          title: t`Could not share ${projectName}`,
          message: failed.message,
          id: 'team-share-project',
        });
        return;
      }
      if (result.skipped_teams?.length) {
        notify.info({
          title: t`${projectName} is already shared`,
          message: t`${teamName} already has access to ${projectName}.`,
          id: 'team-share-project',
        });
      } else if (result.granted_teams?.some((g) => !g.conversation_id)) {
        notify.warning({
          title: t`${projectName} shared`,
          message: t`${teamName} now has access, but the invite message wasn't sent.`,
          id: 'team-share-project',
        });
      } else {
        notify.success({
          title: t`${projectName} shared`,
          message: t`Everyone in ${teamName} now has access.`,
          id: 'team-share-project',
        });
      }
      onClose();
    } catch (e) {
      // The backend explains a refusal in its own words, which are better than
      // anything guessed here.
      notify.error({
        title: t`Could not share ${projectName}`,
        message: errorMessage(e, t`Sharing failed.`),
        id: 'team-share-project',
      });
    } finally {
      setSharing(false);
    }
  }, [project, sharing, teamId, projectName, teamName, onClose, t]);

  const canShare = !!project && !sharing;

  // Inviting needs the Project's hub row: an unpublished Project gets the publish
  // popup INSTEAD of this dialog, and this dialog takes its place once published.
  if (project && project.remote !== true) {
    return <PublishProjectDialog project={project} open onOpenChange={(next) => !next && onClose()} />;
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="team-share-project-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Share {projectName}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Everyone in {teamName} gets this project and sees it in their own project list, in the language the
              project is worked in. Its published skills and documents come with it, from the project's repository on
              the hub.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!canShare}
            onClick={() => void share()}
            data-testid="team-share-project-confirm"
            className="gap-1.5"
          >
            {sharing && <Loader2 className="h-4 w-4 animate-spin" />}
            {sharing ? <Trans>Sharing…</Trans> : <Trans>Share with team</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
