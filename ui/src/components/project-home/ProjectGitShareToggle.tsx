import { Trans, useLingui } from '@lingui/react/macro';
import { Copy, Loader2 } from 'lucide-react';
import { cloudManager, gitOriginRepoFullName } from '@sdk';
import type { Project } from '@sdk';
import { Checkbox } from '@src/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useGitSharePreflight } from '@src/hooks/use-git-share-preflight';
import { useProjectGitShare } from '@src/hooks/use-project-git-share';
import { HUB_HOME_PATH, hubHomeUrl } from '@src/lib/hub-page-url';
import { openExternal } from '@src/lib/open-external';

/** Where a person connects GitHub on the hub — the connection the hub checks a share with. */
function hubConnectionsUrl(): string | null {
  return hubHomeUrl(cloudManager.cloudAppUrl)?.replace(HUB_HOME_PATH, '/dock/hub/credentials/connections') ?? null;
}

/**
 * "Share git with project members": the project's private GitHub repo, cloned and
 * pushed by its members through the hub with their FlowPad login. Their project
 * role decides how (readers pull, editors push).
 *
 * Shown only for a project whose folder has a GitHub origin; usable once the
 * project is linked to the cloud (its members are the hub project's). When GitHub
 * needs a step first — install the Flowpad GitHub App, or connect GitHub on the
 * hub — the row says which, opens the page for it, and offers "Check again".
 */
export function ProjectGitShareToggle({ project }: { project: Project }) {
  const { t } = useLingui();
  const preflight = useGitSharePreflight(project.typeId, true);
  const { share, loading, busy, error, enable, disable } = useProjectGitShare(project);

  const origin = preflight.origin;
  if (!origin || origin.provider.trim().toLowerCase() !== 'github') return null;
  const repo = gitOriginRepoFullName(origin);

  const linked = !!project.remote;
  const shared = share?.status === 'shared';
  const working = busy || loading;

  const turnOn = async () => {
    const next = await enable();
    if (next?.status === 'install_required' && next.install_url) openExternal(next.install_url);
  };
  const onChange = (checked: boolean) => void (checked ? turnOn() : disable());

  const hint = !linked
    ? t`Link the project to the cloud first: its members are the cloud project's members.`
    : t`Members clone and push this repo through FlowPad with their FlowPad login. No GitHub access needed. Readers can pull, editors can push. Uncheck to stop at any time; your GitHub repo is never changed.`;

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="project-git-share">
      <Tooltip>
        <TooltipTrigger asChild>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={shared}
              disabled={!linked || working}
              onCheckedChange={(value) => onChange(value === true)}
              aria-label={t`Share git with project members`}
              data-testid="project-git-share-checkbox"
            />
            <Trans>Share git with project members</Trans>
            {working && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          </label>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs" data-testid="project-git-share-hint">
          {hint}
        </TooltipContent>
      </Tooltip>

      {shared && share?.clone_url && (
        <button
          type="button"
          className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void navigator.clipboard.writeText(share.clone_url ?? '')}
          title={share.clone_url}
          data-testid="project-git-share-copy"
        >
          <Copy className="h-3 w-3" aria-hidden />
          <Trans>Copy members' clone URL</Trans>
        </button>
      )}

      {share?.status === 'install_required' && (
        <div className="flex items-center gap-2 text-xs" data-testid="project-git-share-step">
          <span>
            <Trans>Finish installing the FlowPad GitHub App on {repo}, then</Trans>
          </span>
          <button type="button" className="underline" onClick={() => void turnOn()}>
            <Trans>check again</Trans>
          </button>
        </div>
      )}

      {share?.status === 'github_connect_required' && (
        <div className="flex items-center gap-2 text-xs" data-testid="project-git-share-step">
          <span>
            <Trans>Connect GitHub in FlowPad cloud, so it can check you administer {repo}.</Trans>
          </span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              const url = hubConnectionsUrl();
              if (url) openExternal(url);
            }}
          >
            <Trans>Open connections</Trans>
          </button>
          <button type="button" className="underline" onClick={() => void turnOn()}>
            <Trans>check again</Trans>
          </button>
        </div>
      )}

      {share?.status === 'not_private' && (
        <div className="text-xs text-muted-foreground" data-testid="project-git-share-step">
          <Trans>Public repos are already open to everyone.</Trans>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded border border-destructive bg-destructive/10 px-2 py-1 text-xs text-foreground"
          data-testid="project-git-share-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}
