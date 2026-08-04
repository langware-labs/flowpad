import { gitOriginFromUrl, OAUTH_PROVIDERS, OAuthStatus, oauthService, type GitOrigin, type Project } from '@sdk';
import { useOAuthFlowComplete } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { fetchGithubStatus } from '@src/lib/github-oauth-status';
import type { ContextProject, SandboxSetup } from '@src/hooks/use-desktops';
import { Briefcase, CheckCircle2, GitBranch, Github, Loader2, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** What the user picked as a source — a project they already have, or a repo URL. */
type Source =
  | { kind: 'project'; project: Project }
  | { kind: 'git'; gitOrigin: GitOrigin; name: string };

interface NewDesktopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  /** Pre-fill the sandbox project from a repo URL (e.g. a ?setup_git= deep link). */
  initialGitUrl?: string;
  /** The project the user is working on — the sandbox's project unless changed. */
  currentProject?: Project | null;
  /** Everything they could pick instead, and everything they can add as an asset. */
  projects?: Project[];
  onLaunch: (opts: { name: string; sandboxProject?: SandboxSetup }) => void;
}

/** A source's git origin, when it has one. A project that was never cloned from
 *  anywhere has none — it can still BE the sandbox project (the box mounts it
 *  empty), but there is nothing to clone for it as an asset. */
function originOf(source: Source): GitOrigin | null {
  return source.kind === 'git' ? source.gitOrigin : (source.project.git_origin ?? null);
}

function nameOf(source: Source): string {
  return source.kind === 'git' ? source.name : (source.project.name ?? 'project');
}

/**
 * Start a desktop: name it, say which project it opens on, and add any asset
 * packages — help desks or skills repos that get cloned in, indexed, and
 * attached as context folders of that project.
 *
 * Every row here is one `computeNodeTools` command at launch time; this dialog
 * only decides which. It deliberately does NOT probe repo access first: that
 * probe (`/api/v1/git/remote-access`) is a flow_sdk route the hub does not
 * register, so it 404s for every repo and asked people to connect GitHub for
 * public ones. The clone step reports the real failure, and the banner below
 * still offers the connection a private repo actually needs.
 */
export function NewDesktopDialog({
  open,
  onOpenChange,
  defaultName,
  initialGitUrl,
  currentProject,
  projects,
  onLaunch,
}: NewDesktopDialogProps) {
  const { t } = useLingui();
  const [name, setName] = useState(defaultName);
  const [sandboxSource, setSandboxSource] = useState<Source | null>(null);
  const [assets, setAssets] = useState<Source[]>([]);
  const [picking, setPicking] = useState<null | 'sandbox' | 'asset'>(null);
  const [githubConnected, setGithubConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  // Reset on OPEN only. `defaultName` changes whenever the desktop list refetches
  // (it's derived from it), so depending on it here would wipe what the user has
  // already typed mid-dialog.
  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    const fromUrl = initialGitUrl ? gitOriginFromUrl(initialGitUrl) : null;
    setSandboxSource(
      fromUrl
        ? { kind: 'git', gitOrigin: fromUrl, name: fromUrl.name }
        : currentProject
          ? { kind: 'project', project: currentProject }
          : null,
    );
    setAssets([]);
    setPicking(null);
    setConnecting(false);
    setError('');
    void fetchGithubStatus().then((r) => setGithubConnected(r === true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // An asset has to be cloned, so a project with no repository behind it can't
  // be one — it would attach an empty folder with nothing to index.
  const assetCandidates = useMemo(
    () => (projects ?? []).filter((p) => !!p.git_origin),
    [projects],
  );

  const pick = useCallback(
    (source: Source) => {
      if (picking === 'sandbox') setSandboxSource(source);
      else if (picking === 'asset') {
        const origin = originOf(source);
        if (origin) setAssets((prev) => [...prev, source]);
      }
      setPicking(null);
      setError('');
    },
    [picking],
  );

  const handleSubmit = useCallback(() => {
    const desktopName = name.trim() || defaultName;
    if (!sandboxSource) {
      onOpenChange(false);
      onLaunch({ name: desktopName }); // name-only → plain desktop
      return;
    }
    const origin = originOf(sandboxSource);
    const contextProjects: ContextProject[] = assets.flatMap((asset) => {
      const assetOrigin = originOf(asset);
      // Scope is `shared` for asset packages: they travel with the project.
      return assetOrigin ? [{ gitOrigin: assetOrigin, name: nameOf(asset), scope: 'shared' as const }] : [];
    });
    onOpenChange(false);
    onLaunch({
      name: desktopName,
      sandboxProject: {
        name: nameOf(sandboxSource),
        ...(origin ? { gitOrigin: origin } : {}),
        ...(sandboxSource.kind === 'project' ? { projectId: sandboxSource.project.id } : {}),
        ...(contextProjects.length ? { contextProjects } : {}),
      },
    });
  }, [name, defaultName, sandboxSource, assets, onLaunch, onOpenChange]);

  useOAuthFlowComplete(
    OAUTH_PROVIDERS.GITHUB,
    (msg) => {
      setConnecting(false);
      if (msg.status === OAuthStatus.SUCCESS) setGithubConnected(true);
      else setError(t`GitHub connection failed.`);
    },
    connecting,
  );

  const handleConnectGithub = useCallback(() => {
    setConnecting(true);
    setError('');
    void oauthService.connect(OAUTH_PROVIDERS.GITHUB).catch((e: unknown) => {
      setConnecting(false);
      // Prefer the backend's ApiFailResponse message over axios's generic
      // "Request failed with status code 500" (same unwrap NewProjectFromGitDialog does).
      const ax = e as { response?: { data?: { message?: string } }; message?: string };
      setError(ax.response?.data?.message ?? ax.message ?? t`Couldn't start GitHub connection.`);
    });
  }, [t]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!connecting) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle><Trans>New desktop</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Choose the project it opens on, and any asset packages to load with it.</Trans>
          </DialogDescription>
        </DialogHeader>

        <label className="mb-1 block text-xs font-medium text-muted-foreground"><Trans>Name</Trans></label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName}
          className="mb-3 text-sm"
          autoFocus
        />

        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          <Trans>Sandbox project</Trans>
        </label>
        <div
          className="mb-3 flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
          data-testid="sandbox-project-row"
        >
          {sandboxSource ? (
            <SourceLabel source={sandboxSource} />
          ) : (
            <span className="text-xs text-muted-foreground"><Trans>No project — an empty desktop</Trans></span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => setPicking(picking === 'sandbox' ? null : 'sandbox')}
            data-testid="change-sandbox-project"
          >
            <Trans>Change</Trans>
          </Button>
        </div>

        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          <Trans>Additional assets</Trans>
        </label>
        <div className="mb-1 flex flex-col gap-1" data-testid="asset-list">
          {assets.map((asset, i) => (
            <div
              key={`${nameOf(asset)}-${i}`}
              className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1 text-xs"
            >
              <SourceLabel source={asset} />
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setAssets((prev) => prev.filter((_, at) => at !== i))}
                aria-label={t`Remove ${nameOf(asset)}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setPicking(picking === 'asset' ? null : 'asset')}
          data-testid="add-asset-package"
        >
          <Plus className="mr-1 h-3 w-3" />
          <Trans>Add asset package</Trans>
        </Button>

        {picking && (
          <SourcePicker
            projects={picking === 'asset' ? assetCandidates : (projects ?? [])}
            onPick={pick}
            onInvalidUrl={() => setError(t`Enter a valid GitHub repository URL.`)}
          />
        )}

        {!githubConnected && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">
              <Trans>Tip: connect GitHub to use private repos.</Trans>
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={handleConnectGithub}
              disabled={connecting}
            >
              {connecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Github className="h-3 w-3" />}
              <span className="ml-1.5"><Trans>Connect</Trans></span>
            </Button>
          </div>
        )}
        {githubConnected && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            <Trans>GitHub connected.</Trans>
          </p>
        )}

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={connecting}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={handleSubmit} disabled={connecting} data-testid="launch-desktop">
            <Trans>Launch</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceLabel({ source }: { source: Source }) {
  const origin = originOf(source);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {source.kind === 'project' ? (
        <Briefcase className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{nameOf(source)}</span>
      {!origin && (
        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] uppercase text-muted-foreground">
          <Trans>no repo</Trans>
        </span>
      )}
    </span>
  );
}

/** Pick a project you already have, or paste a repo URL. One panel, used for
 *  both the sandbox project and each asset — the only difference is which
 *  projects the caller passes in. */
function SourcePicker({
  projects,
  onPick,
  onInvalidUrl,
}: {
  projects: Project[];
  onPick: (source: Source) => void;
  onInvalidUrl: () => void;
}) {
  const { t } = useLingui();
  const [url, setUrl] = useState('');

  const submitUrl = () => {
    const gitOrigin = gitOriginFromUrl(url.trim());
    if (!gitOrigin) {
      onInvalidUrl();
      return;
    }
    setUrl('');
    onPick({ kind: 'git', gitOrigin, name: gitOrigin.name });
  };

  return (
    <div className="mt-2 rounded-md border border-border p-2" data-testid="source-picker">
      {projects.length > 0 && (
        <ul className="mb-2 max-h-40 overflow-y-auto">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                onClick={() => onPick({ kind: 'project', project })}
              >
                <Briefcase className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{project.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t`https://github.com/owner/repo`}
          className="font-mono text-xs"
          spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
          data-testid="source-git-url"
        />
        <Button size="sm" variant="outline" className="h-8 shrink-0 px-2 text-xs" onClick={submitUrl}>
          <Trans>Use</Trans>
        </Button>
      </div>
    </div>
  );
}
