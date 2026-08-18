import { t } from '@lingui/core/macro';
import { OAUTH_PROVIDERS, OAuthStatus, cloudManager, launchWizard, oauthService, type Project } from '@sdk';
import { useOAuthFlowComplete } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { GitShareGateDialog } from '@src/components/share-to-conversation/GitShareGateDialog';
import { gitShareGateState } from '@src/components/share-to-conversation/git-share-gate-state';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useGitPush } from '@src/hooks/use-git-push';
import { useGitSharePreflight } from '@src/hooks/use-git-share-preflight';
import { errorMessage } from '@src/lib/error-message';
import { hubPageUrl } from '@src/lib/hub-page-url';
import { fetchGithubStatus } from '@src/lib/github-oauth-status';
import { openExternal } from '@src/lib/open-external';
import { notify } from '@src/notifications';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { CheckCircle2, CloudUpload, ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface ProjectPublishButtonProps {
  project: Project;
}

/**
 * Desktop Project publication control.
 *
 * Git state comes exclusively from the backend preflight. Remediations reuse
 * the established exact-folder setup wizard, whole-worktree push, cloud-login,
 * and GitHub OAuth seams. The final mutation is still the ordinary
 * `project.share()` action; this component never writes `remote` itself.
 */
export function ProjectPublishButton({ project }: ProjectPublishButtonProps) {
  const { t } = useLingui();
  const hubMode = isHubOnly();
  const published = project.remote === true;
  const projectTypeId = project.typeId;
  const preflight = useGitSharePreflight(projectTypeId, !hubMode && !published);
  // The preflight owns Git truth, so nothing is actionable until it answers.
  const checking = preflight.loading || !preflight.answered;
  const requireCloudLogin = useCloudLoginGate();
  const [gateOpen, setGateOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [githubChecking, setGithubChecking] = useState(false);
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [resumeWhenReady, setResumeWhenReady] = useState(false);
  const publishInFlight = useRef(false);

  const { push, busy: pushBusy } = useGitPush('@local', project.fs_storage_mount_path ?? null, preflight.refetch);

  const publishReadyProject = useCallback(async () => {
    if (publishInFlight.current || project.remote === true) return;
    publishInFlight.current = true;
    setPublishing(true);
    try {
      const login = await requireCloudLogin();
      if (!login.ok) {
        notify.error({ title: t`Could not link project to cloud`, message: login.error });
        return;
      }
      const canonical = await project.share();
      if (canonical.remote !== true) {
        throw new Error('The server did not confirm the cloud link.');
      }
      setGateOpen(false);
      notify.success({ title: t`Project linked to cloud`, message: t`This project is now available in the cloud.` });
    } catch (error) {
      notify.error({ title: t`Could not link project to cloud`, message: errorMessage(error, t`Linking failed.`) });
    } finally {
      publishInFlight.current = false;
      setPublishing(false);
    }
  }, [project, requireCloudLogin, t]);

  const runSetup = useCallback(async () => {
    const mount = project.fs_storage_mount_path;
    if (!mount || setupBusy) return;
    setSetupBusy(true);
    // Hand the screen to the wizard BEFORE awaiting it. `git-context-folder`
    // finishes its work and then waits for the user to press Done, so
    // `launchWizard` stays pending for as long as that wizard is open. Leaving
    // this modal up means the person the wizard is waiting for is told
    // "Checking Git…" over the top of it — and since `setupBusy` keeps the gate
    // in its `checking` face, the only face with no action, the dialog can never
    // resolve on its own. The user saw an unchanging spinner while the setup had
    // in fact already succeeded. Closing here is what makes the wizard reachable;
    // the `resumeWhenReady` flag below carries the publish on once it returns.
    setGateOpen(false);
    try {
      const result = await launchWizard('git-context-folder', {
        title: t`Set up Git for cloud linking`,
        targetTypeId: project.typeId.toString(),
        payload: {
          projectId: project.id,
          scope: 'private',
          mode: 'adopt',
          path: mount,
          name: project.name,
        },
        prompt:
          `Set up Git in the exact project folder ${mount}. Initialize it there if needed, ` +
          'configure a GitHub origin, commit the entire repository, and push its branch. Do not clone or copy it elsewhere.',
      });
      // Say something on every way out. The wizard runs on its own surface, so
      // this button is off-screen when it lands — without a notification the
      // user is left to guess whether the setup took, which is exactly what
      // happened when the gate sat there claiming to still be checking.
      if (result.status === 'done') {
        notify.success({
          title: t`Git is set up`,
          message: t`Linking ${project.name ?? 'this project'} to the cloud…`,
        });
        setResumeWhenReady(true);
      } else if (result.status === 'error') {
        notify.error({ title: t`Could not set up Git`, message: result.errorStr ?? undefined });
      } else {
        // Cancelled. Silence here reads as a failure the user can't see, and
        // the publish they asked for is simply not happening.
        notify.info({ title: t`Git setup cancelled`, message: t`The project was not linked to the cloud.` });
      }
    } catch (error) {
      notify.error({ title: t`Could not set up Git`, message: errorMessage(error, t`Git setup failed.`) });
    } finally {
      setSetupBusy(false);
      preflight.refetch();
    }
  }, [preflight, project, setupBusy, t]);

  const runCommit = useCallback(async () => {
    setResumeWhenReady(true);
    await push();
  }, [push]);

  // Subscribed only while this button's own connect is pending, so an abandoned
  // flow can't leave a listener behind and someone else's connect can't publish.
  useOAuthFlowComplete(
    OAUTH_PROVIDERS.GITHUB,
    (message) => {
      setOauthConnecting(false);
      if (message.status !== OAuthStatus.SUCCESS) {
        notify.error({ title: t`Could not connect GitHub`, message: t`GitHub authorization did not complete.` });
        return;
      }
      void fetchGithubStatus().then((connected) => {
        if (connected === false) {
          notify.error({ title: t`Could not connect GitHub`, message: t`GitHub authorization did not complete.` });
          return;
        }
        void publishReadyProject();
      });
    },
    oauthConnecting,
  );

  const connectGitHub = useCallback(async () => {
    if (oauthConnecting) return;
    setOauthConnecting(true);
    try {
      await oauthService.connect(OAUTH_PROVIDERS.GITHUB);
    } catch (error) {
      setOauthConnecting(false);
      notify.error({
        title: t`Could not connect GitHub`,
        message: errorMessage(error, t`GitHub authorization did not complete.`),
      });
    }
  }, [oauthConnecting, t]);

  const checkGithubAndPublish = useCallback(async () => {
    if (githubChecking || oauthConnecting || publishing) return;
    setGithubChecking(true);
    try {
      const connected = await fetchGithubStatus();
      if (connected === false) {
        await connectGitHub();
        return;
      }
      await publishReadyProject();
    } finally {
      setGithubChecking(false);
    }
  }, [connectGitHub, githubChecking, oauthConnecting, publishReadyProject, publishing]);

  // A remediation re-checks exactly once when it completes. Only an explicit
  // Publish intent sets this flag; an ordinary preflight on mount can never
  // auto-publish the Project.
  useEffect(() => {
    if (!resumeWhenReady || checking) return;
    setResumeWhenReady(false);
    if (!preflight.available) {
      // The remediation reported success and we told the user we were linking —
      // but the re-check still says no. Saying nothing here would leave that
      // promise hanging exactly like the stuck gate did; the backend's own
      // reason is the only useful thing to hand back.
      notify.error({
        title: t`Still can't link this project`,
        message: preflight.reason ?? t`Git setup finished, but the project still isn't ready to link.`,
      });
      return;
    }
    void checkGithubAndPublish();
  }, [resumeWhenReady, checking, preflight.available, preflight.reason, checkGithubAndPublish, t]);

  const remediation = gitShareGateState(preflight.code);
  const busy = publishing || githubChecking || setupBusy || pushBusy || oauthConnecting;
  const blocked = busy || checking;
  const gate = useMemo(
    () => ({
      state: blocked ? 'checking' : remediation,
      reason: preflight.reason,
      busy,
      runSetup,
      runCommit,
    }),
    [blocked, busy, preflight.reason, remediation, runCommit, runSetup],
  );

  const beginPublish = useCallback(() => {
    if (blocked) return;
    if (preflight.available) {
      void checkGithubAndPublish();
      return;
    }
    setGateOpen(true);
  }, [blocked, checkGithubAndPublish, preflight.available]);

  // The Hub Project page is read-only with respect to desktop publication.
  if (hubMode) return null;

  if (published) {
    const url = hubPageUrl(cloudManager.cloudAppUrl, project.typeId);
    const body = (
      <>
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        <span>
          <Trans>Linked to cloud</Trans>
        </span>
        {url && <ExternalLink className="h-3 w-3" aria-hidden />}
      </>
    );
    // `data-state` deliberately still says "published" while the label says
    // "Linked to cloud": the label is copy, the state is a wire value asserted
    // by three test files and matching the backend's `hub_published_at` /
    // `project_not_published` vocabulary. Renaming it is a code change
    // disguised as a copy change — don't.
    return url ? (
      <a
        href={url}
        onClick={(event) => {
          event.preventDefault();
          openExternal(url);
        }}
        data-testid="project-publish"
        data-state="published"
        title={t`Open project in cloud`}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-green-600/30 bg-green-600/10 px-2 text-xs font-medium text-green-700 transition-colors hover:bg-green-600/15 dark:text-green-400"
      >
        {body}
      </a>
    ) : (
      <span
        data-testid="project-publish"
        data-state="published"
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-green-600/30 bg-green-600/10 px-2 text-xs font-medium text-green-700 dark:text-green-400"
      >
        {body}
      </span>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={beginPublish}
        disabled={blocked}
        data-testid="project-publish"
        data-state="local"
        className="h-7 gap-1.5 px-2 text-xs"
      >
        {blocked ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <CloudUpload className="h-3.5 w-3.5" aria-hidden />
        )}
        {publishing ? <Trans>Linking…</Trans> : checking ? <Trans>Checking…</Trans> : <Trans>Link to cloud</Trans>}
      </Button>

      <GitShareGateDialog
        open={gateOpen}
        onOpenChange={setGateOpen}
        folderName={project.displayName || project.name || 'Project'}
        gate={gate}
      />
    </>
  );
}
