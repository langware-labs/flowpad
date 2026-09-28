/**
 * Handing a project to a whole team, from the People & teams page.
 *
 * The page's other share control (`OrgSharePanel`) hands someone the
 * ORGANIZATION. This hands the team a piece of WORK: pick one project and
 * everyone in the team — including everyone in any team nested inside it — is
 * invited to it in one press, at `member`. The hub's assignment policy grants
 * them immediately, so nobody has to accept anything; explicit acceptance stays
 * the fallback the hub falls back to on its own.
 *
 * **What actually travels.** Sharing links the project to the hub
 * (`Project.share`), which carries its metadata — its `locale`, so a recipient
 * opens it in the language its author works in — and its shared context and
 * secret DECLARATIONS. Its published assets live in the project's hub-hosted
 * repository, which every member reaches with their own hub login, so linking
 * needs no git repository, remote or GitHub connection on the sender's side.
 *
 * **Nothing here re-implements the publish rules.** Whether a project may be
 * linked to the cloud is `assert_project_publishable`'s decision, made
 * server-side on the share call; a refusal is shown in the backend's own words.
 */
import { TypeId, type Project } from '@sdk';
import { FolderGit2, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';

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
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { collectTeamRecipients, type TeamRecipients } from './team-recipients';

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
        description={<Trans>Everyone in {teamName} will be invited to the project you pick.</Trans>}
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

  const [recipients, setRecipients] = useState<TeamRecipients | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  // One roster walk per opening. The dialog is the button press, so this is not
  // work anybody pays for by rendering the page.
  useEffect(() => {
    let cancelled = false;
    collectTeamRecipients(new TypeId('team', teamId))
      .then((r) => {
        if (!cancelled) setRecipients(r);
      })
      .catch((e) => {
        if (!cancelled) setRosterError(errorMessage(e, t`Couldn't read this team's people.`));
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, t]);

  const share = useCallback(async () => {
    if (!project || !recipients?.emails.length || sharing) return;
    setSharing(true);
    try {
      await project.share(recipients.emails);
      notify.success({
        title: t`${projectName} shared`,
        message: t`Everyone in ${teamName} has been invited.`,
        id: 'team-share-project',
      });
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
  }, [project, recipients, sharing, projectName, teamName, onClose, t]);

  const people = recipients?.emails.length ?? 0;
  const checking = !recipients;
  const canShare = !!project && !checking && people > 0 && !sharing;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="team-share-project-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Share {projectName}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Everyone in {teamName} is invited to this project and sees it in their own project list, in the language
              the project is worked in. Its published skills and documents come with it, from the project's repository
              on the hub.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          {rosterError ? (
            <p className="text-destructive" data-testid="team-share-project-roster-error">
              {rosterError}
            </p>
          ) : !recipients ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <Trans>Reading this team's people…</Trans>
            </p>
          ) : (
            <p data-testid="team-share-project-recipients">
              <Plural value={people} one="# person will be invited." other="# people will be invited." />
              {recipients.unreachable > 0 && (
                <span className="text-muted-foreground">
                  {' '}
                  <Plural
                    value={recipients.unreachable}
                    one="# person on this team has no email address, so they can't be invited."
                    other="# people on this team have no email address, so they can't be invited."
                  />
                </span>
              )}
            </p>
          )}

          {project && project.remote !== true && (
            <p className="text-muted-foreground" data-testid="team-share-project-will-link">
              <Trans>This project isn't in the cloud yet — sharing it links it there first.</Trans>
            </p>
          )}
        </div>

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
            {(sharing || checking) && <Loader2 className="h-4 w-4 animate-spin" />}
            {sharing ? <Trans>Sharing…</Trans> : <Trans>Share with team</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
