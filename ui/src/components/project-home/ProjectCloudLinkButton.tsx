import { cloudManager, type Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { errorMessage } from '@src/lib/error-message';
import { hubPageUrl } from '@src/lib/hub-page-url';
import { openExternal } from '@src/lib/open-external';
import { notify } from '@src/notifications';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { CheckCircle2, CloudUpload, ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface ProjectCloudLinkButtonProps {
  project: Project;
}

/**
 * Desktop Project cloud-link control.
 *
 * Linking needs a cloud login and nothing else: the project's published assets
 * travel through its hub-hosted repository, so the folder does not have to be a
 * git checkout, have a remote, be clean or pushed, or have GitHub connected.
 * The mutation is the ordinary `project.share()` action behind the cloud-login
 * gate; this component never writes `remote` itself.
 *
 * Once linked, "Send files to cloud" copies the whole folder (as git sees it) to that same
 * repository — what a launch link or a sandbox needs to check the project out.
 */
export function ProjectCloudLinkButton({ project }: ProjectCloudLinkButtonProps) {
  const { t } = useLingui();
  const hubMode = isHubOnly();
  const published = project.remote === true;
  const requireCloudLogin = useCloudLoginGate();
  const [publishing, setPublishing] = useState(false);
  const publishInFlight = useRef(false);

  const linkProject = useCallback(async () => {
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
      notify.success({ title: t`Project linked to cloud`, message: t`This project is now available in the cloud.` });
    } catch (error) {
      notify.error({ title: t`Could not link project to cloud`, message: errorMessage(error, t`Linking failed.`) });
    } finally {
      publishInFlight.current = false;
      setPublishing(false);
    }
  }, [project, requireCloudLogin, t]);

  const sendFiles = useCallback(async () => {
    if (publishInFlight.current) return;
    publishInFlight.current = true;
    setPublishing(true);
    try {
      await project.publishFiles();
      notify.success({ title: t`Files sent to cloud`, message: t`This project can now be opened from the cloud.` });
    } catch (error) {
      notify.error({ title: t`Could not send the files`, message: errorMessage(error, t`Sending failed.`) });
    } finally {
      publishInFlight.current = false;
      setPublishing(false);
    }
  }, [project, t]);

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
    const badge = url ? (
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
    return (
      <span className="inline-flex items-center gap-1.5">
        {badge}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void sendFiles()}
          disabled={publishing}
          data-testid="project-publish-files"
          title={t`Copy this project's files to its cloud repository, so it can be opened on another machine or in a sandbox`}
          className="h-7 gap-1.5 px-2 text-xs"
        >
          {publishing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" aria-hidden />
          )}
          <Trans>Send files to cloud</Trans>
        </Button>
      </span>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      onClick={() => void linkProject()}
      disabled={publishing}
      data-testid="project-publish"
      data-state="local"
      className="h-7 gap-1.5 px-2 text-xs"
    >
      {publishing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <CloudUpload className="h-3.5 w-3.5" aria-hidden />
      )}
      {publishing ? <Trans>Linking…</Trans> : <Trans>Link to cloud</Trans>}
    </Button>
  );
}
