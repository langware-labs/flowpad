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
 * **What actually travels, and what doesn't.** Sharing publishes the project to
 * the hub (`Project.share`), which carries its metadata — its `locale`, so a
 * recipient opens it in the language its author works in — and its shared
 * context and secret DECLARATIONS. The files, and therefore the project's
 * skills, travel by Git: the recipient's client clones the repository the first
 * time they open the project. That split is the whole reason this dialog exists
 * rather than a bare button.
 *
 * **Which is why a private repository is a warning and not a footnote.** The
 * clone runs with the RECIPIENT's own GitHub credential (anonymous when they
 * have none), and Flowpad grants Flowpad membership — never GitHub access. So a
 * private repo shares perfectly, shows up in everyone's project picker in the
 * right language, and then refuses to open for every person who is not already a
 * collaborator on it. `useGitAnonymousAccess` asks that question with the
 * admin's own credential helpers switched off, and the answer is shown BEFORE
 * the invitations go out, because afterwards it is N people's problem.
 *
 * **Nothing here re-implements the publish rules.** Whether a project may be
 * linked to the cloud at all is `assert_project_publishable`'s decision, made
 * server-side on the share call; `useGitSharePreflight` is the same authority
 * asked early so the admin sees the blocker before pressing rather than after.
 */
import { OAUTH_PROVIDERS, OAuthStatus, TypeId, oauthService, type Project } from '@sdk';
import { useOAuthFlowComplete } from '@sdk/react/hooks';
import { AlertTriangle, FolderGit2, Loader2 } from 'lucide-react';
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
import { useGitAnonymousAccess } from '@src/hooks/use-git-anonymous-access';
import { useGitSharePreflight } from '@src/hooks/use-git-share-preflight';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

import { collectTeamRecipients, type TeamRecipients } from './team-recipients';

/**
 * The backend's machine code for a refused share.
 *
 * `describeApiError` reads `data.error_code`, which is the REST routes' spelling;
 * the graph actions put theirs at `data.code` (`ProjectPublishBlocked.data()`).
 * Only one code is branched on here — everything else is shown as its own
 * sentence, which the backend always supplies.
 */
function shareFailureCode(error: unknown): string {
  const e = error as { response?: { data?: { data?: { code?: unknown } } } } | null;
  const code = e?.response?.data?.data?.code;
  return typeof code === 'string' ? code : '';
}

/** The header control. Rendered where the hub says the caller may run this team. */
export function ShareProjectButton({ teamId, teamName }: { teamId: string; teamName: string }) {
  const { t } = useLingui();
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);

  // The projects being shared are on the SENDER's machine — the picker lists
  // them from the local compute node and the git checks read a local worktree.
  // The hub runtime has neither, so the same People & teams page rendered there
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
  const preflight = useGitSharePreflight(projectTypeId, true);
  const access = useGitAnonymousAccess(projectTypeId, true);

  const [recipients, setRecipients] = useState<TeamRecipients | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [needsGitHub, setNeedsGitHub] = useState(false);
  const [connecting, setConnecting] = useState(false);

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
      // The one refusal with a one-click fix. Everything else the backend
      // explains in its own words, which are better than anything guessed here.
      if (shareFailureCode(e) === 'github_not_connected') {
        setNeedsGitHub(true);
        return;
      }
      notify.error({
        title: t`Could not share ${projectName}`,
        message: errorMessage(e, t`Sharing failed.`),
        id: 'team-share-project',
      });
    } finally {
      setSharing(false);
    }
  }, [project, recipients, sharing, projectName, teamName, onClose, t]);

  // Subscribed only while THIS dialog's connect is pending, so an abandoned flow
  // leaves no listener behind and someone else's connect can't share a project.
  useOAuthFlowComplete(
    OAUTH_PROVIDERS.GITHUB,
    (message) => {
      setConnecting(false);
      if (message.status !== OAuthStatus.SUCCESS) {
        notify.error({ title: t`Could not connect GitHub`, message: t`GitHub authorization did not complete.` });
        return;
      }
      setNeedsGitHub(false);
      void share();
    },
    connecting,
  );

  const connectGitHub = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      await oauthService.connect(OAUTH_PROVIDERS.GITHUB);
    } catch (e) {
      setConnecting(false);
      notify.error({
        title: t`Could not connect GitHub`,
        message: errorMessage(e, t`GitHub authorization did not complete.`),
      });
    }
  }, [connecting, t]);

  const people = recipients?.emails.length ?? 0;
  const repoLabel = access.repo ?? t`this project uses`;
  const checking = !preflight.answered || !recipients;
  const blocked = preflight.answered && !preflight.available;
  const canShare = !!project && !checking && !blocked && people > 0 && !sharing && !connecting;

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
              the project is worked in. Its skills travel with its files, over Git.
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

          {blocked && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive"
              data-testid="team-share-project-blocked"
            >
              {preflight.reason ?? <Trans>This project isn't ready to link to the cloud.</Trans>}{' '}
              <Trans>Open the project and use "Link to cloud" to finish setting it up.</Trans>
            </p>
          )}

          {/* (b) Warn up front. Shown even while the rest is fine — being able to
              share is exactly when this matters. */}
          {access.public === false && (
            <p
              className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-amber-700 dark:text-amber-400"
              data-testid="team-share-project-private-repo"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <Trans>
                  The repository {repoLabel} is private. Everyone here will still see the project and its language, but
                  only people who connect GitHub and already have access to that repository can open its files and its
                  skills — Flowpad can't grant that access.
                </Trans>
              </span>
            </p>
          )}

          {needsGitHub && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
              data-testid="team-share-project-connect-github"
            >
              <span className="text-muted-foreground">
                <Trans>Connect GitHub to link this project to the cloud.</Trans>
              </span>
              <Button size="sm" disabled={connecting} onClick={() => void connectGitHub()}>
                {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
                <Trans>Connect GitHub</Trans>
              </Button>
            </div>
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
