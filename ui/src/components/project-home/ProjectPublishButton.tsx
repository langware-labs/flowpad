import { OAUTH_PROVIDERS, cloudManager, connectionManager, launchWizard, oauthService, type Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { GitShareGateDialog } from '@src/components/share-to-conversation/GitShareGateDialog';
import { gitShareGateState } from '@src/components/share-to-conversation/git-share-gate-state';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useGitPush } from '@src/hooks/use-git-push';
import { useGitSharePreflight } from '@src/hooks/use-git-share-preflight';
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

function errorText(error: unknown): string {
  const envelope = (error as { response?: { data?: { message?: string; detail?: string } } })?.response?.data;
  return envelope?.message || envelope?.detail || (error instanceof Error ? error.message : String(error));
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
  const requireCloudLogin = useCloudLoginGate();
  const [gateOpen, setGateOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [githubChecking, setGithubChecking] = useState(false);
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [resumeWhenReady, setResumeWhenReady] = useState(false);
  const publishInFlight = useRef(false);
  const oauthHandler = useRef<((message: { auth_method?: string; status?: string }) => void) | null>(null);

  const { push, busy: pushBusy } = useGitPush('@local', project.fs_storage_mount_path ?? null, preflight.refetch);

  const clearOAuthHandler = useCallback(() => {
    if (!oauthHandler.current) return;
    connectionManager.off('on_llm_config_msg', oauthHandler.current);
    oauthHandler.current = null;
  }, []);

  useEffect(() => clearOAuthHandler, [clearOAuthHandler]);

  const publishReadyProject = useCallback(async () => {
    if (publishInFlight.current || project.remote === true) return;
    publishInFlight.current = true;
    setPublishing(true);
    try {
      const login = await requireCloudLogin();
      if (!login.ok) {
        notify.error({ title: t`Could not publish project`, message: login.error });
        return;
      }
      const canonical = await project.share();
      if (canonical.remote !== true) {
        throw new Error('The server did not confirm Project publication.');
      }
      setGateOpen(false);
      notify.success({ title: t`Project published`, message: t`This project is now available in the cloud.` });
    } catch (error) {
      notify.error({ title: t`Could not publish project`, message: errorText(error) });
    } finally {
      publishInFlight.current = false;
      setPublishing(false);
    }
  }, [project, requireCloudLogin, t]);

  const runSetup = useCallback(async () => {
    const mount = project.fs_storage_mount_path;
    if (!mount || setupBusy) return;
    setSetupBusy(true);
    try {
      const result = await launchWizard('git-context-folder', {
        title: 'Set up Git for project publishing',
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
      if (result.status === 'done') setResumeWhenReady(true);
      else if (result.status === 'error') {
        notify.error({ title: t`Could not set up Git`, message: result.errorStr ?? undefined });
      }
    } catch (error) {
      notify.error({ title: t`Could not set up Git`, message: errorText(error) });
    } finally {
      setSetupBusy(false);
      preflight.refetch();
    }
  }, [preflight, project, setupBusy, t]);

  const runCommit = useCallback(async () => {
    setResumeWhenReady(true);
    await push();
  }, [push]);

  const connectGitHub = useCallback(async () => {
    if (oauthConnecting) return;
    clearOAuthHandler();
    setOauthConnecting(true);
    const handler = (message: { auth_method?: string; status?: string }) => {
      if (message.auth_method !== OAUTH_PROVIDERS.GITHUB) return;
      clearOAuthHandler();
      setOauthConnecting(false);
      if (message.status === 'success') {
        void fetchGithubStatus().then((connected) => {
          if (connected === false) {
            notify.error({
              title: t`Could not connect GitHub`,
              message: t`GitHub authorization did not complete.`,
            });
            return;
          }
          void publishReadyProject();
        });
      } else {
        notify.error({ title: t`Could not connect GitHub`, message: t`GitHub authorization did not complete.` });
      }
    };
    oauthHandler.current = handler;
    connectionManager.on('on_llm_config_msg', handler);
    try {
      await oauthService.connect(OAUTH_PROVIDERS.GITHUB);
    } catch (error) {
      clearOAuthHandler();
      setOauthConnecting(false);
      notify.error({ title: t`Could not connect GitHub`, message: errorText(error) });
    }
  }, [clearOAuthHandler, oauthConnecting, publishReadyProject, t]);

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
    if (!resumeWhenReady || preflight.loading || !preflight.answered || !preflight.available) return;
    setResumeWhenReady(false);
    void checkGithubAndPublish();
  }, [resumeWhenReady, preflight.loading, preflight.answered, preflight.available, checkGithubAndPublish]);

  const remediation = gitShareGateState(preflight.code);
  const busy = publishing || githubChecking || setupBusy || pushBusy || oauthConnecting;
  const gate = useMemo(
    () => ({
      state: preflight.loading || busy || !preflight.answered ? 'checking' : remediation,
      reason: preflight.reason,
      busy,
      runSetup,
      runCommit,
    }),
    [busy, preflight.answered, preflight.loading, preflight.reason, remediation, runCommit, runSetup],
  );

  const beginPublish = useCallback(() => {
    if (busy || preflight.loading || !preflight.answered) return;
    if (preflight.available) {
      void checkGithubAndPublish();
      return;
    }
    setGateOpen(true);
  }, [busy, checkGithubAndPublish, preflight.answered, preflight.available, preflight.loading]);

  // The Hub Project page is read-only with respect to desktop publication.
  if (hubMode) return null;

  if (published) {
    const url = hubPageUrl(cloudManager.cloudAppUrl, project.typeId);
    const body = (
      <>
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        <span>
          <Trans>Published</Trans>
        </span>
        {url && <ExternalLink className="h-3 w-3" aria-hidden />}
      </>
    );
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
        disabled={busy || preflight.loading || !preflight.answered}
        data-testid="project-publish"
        data-state="local"
        className="h-7 gap-1.5 px-2 text-xs"
      >
        {busy || preflight.loading || !preflight.answered ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <CloudUpload className="h-3.5 w-3.5" aria-hidden />
        )}
        {publishing ? (
          <Trans>Publishing…</Trans>
        ) : preflight.loading || !preflight.answered ? (
          <Trans>Checking…</Trans>
        ) : (
          <Trans>Publish</Trans>
        )}
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
