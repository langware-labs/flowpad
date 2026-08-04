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
import { ProjectSelector } from '@src/components/project-selector/ProjectSelector';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import { cn } from '@src/lib/utils';
import { fetchGithubStatus } from '@src/lib/github-oauth-status';
import type { ContextProject, SandboxSetup } from '@src/hooks/use-desktops';
import { Briefcase, CheckCircle2, GitBranch, Github, Link2, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * A picked source, normalised at pick time.
 *
 * `gitOrigin` is null for a project that was never cloned from anywhere — it
 * can still be the project the desktop loads (the box mounts it empty), but it
 * has nothing to clone as an asset. `projectId` is set when the user picked an
 * existing project rather than pasting a URL, and is what the box adopts so one
 * id spans hub and sandbox.
 */
interface Source {
  name: string;
  gitOrigin: GitOrigin | null;
  projectId?: string;
}

/** Which chip's panel is open in a field, if any. */
type Panel = 'project' | 'url';

function sourceFromProject(project: Project): Source {
  return { name: project.displayName, gitOrigin: project.git_origin ?? null, projectId: project.id };
}

interface NewDesktopDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  /** Pre-fill the project to load from a repo URL (e.g. a ?setup_git= deep link). */
  initialGitUrl?: string;
  /** The project the user is working on — loaded unless they change it. */
  currentProject?: Project | null;
  /** Everything they could load instead, and everything they can add as an asset. */
  projects?: Project[];
  onLaunch: (opts: { name: string; sandboxProject?: SandboxSetup }) => void;
}

/**
 * Start a desktop: name it, say which project it loads, and add any asset
 * packages — help desks or skills repos that get cloned in, indexed, and
 * attached as context folders of that project.
 *
 * Both fields are the same control ({@link SourceField}): the picks as
 * removable pills, then chips — pick a project, paste a URL — each opening its
 * own panel directly underneath. The only difference is what a pick does
 * (replace vs. append) and which projects are on offer.
 *
 * It deliberately does NOT probe repo access first: that probe
 * (`/api/v1/git/remote-access`) is a flow_sdk route the hub does not register,
 * so it 404s for every repo and asked people to connect GitHub for public ones.
 * The clone step reports the real failure.
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
  const [loadedProject, setLoadedProject] = useState<Source | null>(null);
  const [assets, setAssets] = useState<Source[]>([]);
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
    setLoadedProject(
      fromUrl
        ? { name: fromUrl.name, gitOrigin: fromUrl }
        : currentProject
          ? sourceFromProject(currentProject)
          : null,
    );
    setAssets([]);
    setConnecting(false);
    setError('');

    // `null` means the question couldn't be asked yet — the bootstrap race where
    // `userTypeId` isn't populated — so retry briefly rather than reporting a
    // connection the user does have as missing (same as NewProjectFromGitDialog).
    let cancelled = false;
    const poll = () => {
      void fetchGithubStatus().then((r) => {
        if (cancelled) return;
        if (r === null) setTimeout(poll, 500);
        else setGithubConnected(r);
      });
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // An asset has to be cloned, so a project with no repository behind it can't
  // be one — it would attach an empty folder with nothing to index.
  const assetCandidates = useMemo(() => (projects ?? []).filter((p) => !!p.git_origin), [projects]);

  const connectGithub = useCallback(() => {
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

  useOAuthFlowComplete(
    OAUTH_PROVIDERS.GITHUB,
    (msg) => {
      setConnecting(false);
      if (msg.status === OAuthStatus.SUCCESS) setGithubConnected(true);
      else setError(t`GitHub connection failed.`);
    },
    connecting,
  );

  const onInvalidUrl = useCallback(() => setError(t`Enter a valid GitHub repository URL.`), [t]);

  const handleSubmit = useCallback(() => {
    const desktopName = name.trim() || defaultName;
    if (!loadedProject) {
      onOpenChange(false);
      onLaunch({ name: desktopName }); // nothing to load → a plain desktop
      return;
    }
    // Scope is `shared` for asset packages: they travel with the project.
    const contextProjects: ContextProject[] = assets.flatMap((asset) =>
      asset.gitOrigin ? [{ gitOrigin: asset.gitOrigin, name: asset.name, scope: 'shared' as const }] : [],
    );
    onOpenChange(false);
    onLaunch({
      name: desktopName,
      sandboxProject: {
        name: loadedProject.name,
        ...(loadedProject.gitOrigin ? { gitOrigin: loadedProject.gitOrigin } : {}),
        ...(loadedProject.projectId ? { projectId: loadedProject.projectId } : {}),
        ...(contextProjects.length ? { contextProjects } : {}),
      },
    });
  }, [name, defaultName, loadedProject, assets, onLaunch, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!connecting) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle><Trans>New desktop</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Choose the project it loads, and any asset packages to bring with it.</Trans>
          </DialogDescription>
        </DialogHeader>

        <label className="mb-1 block text-xs font-medium text-muted-foreground"><Trans>Name</Trans></label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName}
          className="mb-4 text-sm"
          autoFocus
        />

        <SourceField
          label={t`Project to load`}
          testId="loaded-project"
          projects={projects ?? []}
          values={loadedProject ? [loadedProject] : []}
          onPick={setLoadedProject}
          onRemove={() => setLoadedProject(null)}
          emptyHint={t`Nothing selected — launches an empty desktop.`}
          onInvalidUrl={onInvalidUrl}
        />

        <SourceField
          label={t`Additional assets`}
          testId="assets"
          projects={assetCandidates}
          values={assets}
          onPick={(source) => setAssets((prev) => [...prev, source])}
          onRemove={(index) => setAssets((prev) => prev.filter((_, at) => at !== index))}
          emptyHint={t`Help desks or skills repos to load alongside it.`}
          onInvalidUrl={onInvalidUrl}
        />

        {/* One connection, stated once — both fields use the same credential. */}
        {githubConnected ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="github-connected">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            <Trans>GitHub connected — private repos are available.</Trans>
          </p>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
            <span className="text-muted-foreground">
              <Trans>Tip: connect GitHub to use private repos.</Trans>
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={connectGithub}
              disabled={connecting}
              data-testid="connect-github"
            >
              {connecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Github className="h-3 w-3" />}
              <span className="ml-1.5"><Trans>Connect</Trans></span>
            </Button>
          </div>
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

/**
 * One labelled field: what's picked so far, then the two ways to pick more.
 *
 * Used verbatim for the loaded project and for the asset packages — the caller
 * only decides whether a pick replaces or appends, and which projects are on
 * offer. The panel for a chip opens directly under the chip row, so the choice
 * and its consequence stay in one place.
 */
function SourceField({
  label,
  testId,
  projects,
  values,
  onPick,
  onRemove,
  emptyHint,
  onInvalidUrl,
}: {
  label: string;
  testId: string;
  projects: Project[];
  values: Source[];
  onPick: (source: Source) => void;
  onRemove: (index: number) => void;
  emptyHint: string;
  onInvalidUrl: () => void;
}) {
  const { t } = useLingui();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [url, setUrl] = useState('');

  const pickedIds = useMemo(
    () => values.map((v) => v.projectId).filter((id): id is string => !!id),
    [values],
  );

  const pick = (source: Source) => {
    setPanel(null);
    setUrl('');
    onPick(source);
  };

  const submitUrl = () => {
    const gitOrigin = gitOriginFromUrl(url.trim());
    if (!gitOrigin) {
      onInvalidUrl();
      return;
    }
    pick({ name: gitOrigin.name, gitOrigin });
  };

  return (
    <div className="mb-4" data-testid={`${testId}-field`}>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>

      {values.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid={`${testId}-values`}>
          {values.map((source, i) => (
            <span
              key={`${source.name}-${i}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pl-2 pr-1 text-xs"
            >
              {source.projectId ? (
                <Briefcase className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{source.name}</span>
              {!source.gitOrigin && (
                <span className="shrink-0 text-[10px] uppercase text-muted-foreground"><Trans>no repo</Trans></span>
              )}
              <button
                type="button"
                className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onRemove(i)}
                aria-label={t`Remove ${source.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mb-1.5 text-[11px] text-muted-foreground">{emptyHint}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {/* Offered while there is still something unpicked to offer: for the
            loaded project that hides a list of the one project already chosen,
            for assets it keeps a single candidate reachable. */}
        {projects.length > pickedIds.length && (
          <Chip
            active={panel === 'project'}
            onClick={() => setPanel((p) => (p === 'project' ? null : 'project'))}
            testId={`${testId}-chip-project`}
            label={t`Select project`}
            icon={<Briefcase className="h-3 w-3" />}
          />
        )}
        <Chip
          active={panel === 'url'}
          onClick={() => setPanel((p) => (p === 'url' ? null : 'url'))}
          testId={`${testId}-chip-url`}
          label={t`Git URL`}
          icon={<Link2 className="h-3 w-3" />}
        />
      </div>

      {panel === 'project' && (
        <div className="mt-1.5 rounded-md border border-border p-1" data-testid={`${testId}-projects`}>
          <ProjectSelector
            projects={projectEntitiesToSelectorItems(projects)}
            selectedId={null}
            excludeIds={pickedIds}
            onSelect={(id) => {
              const project = projects.find((p) => p.id === id);
              if (project) pick(sourceFromProject(project));
            }}
          />
        </div>
      )}

      {panel === 'url' && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t`https://github.com/owner/repo`}
            className="h-8 font-mono text-xs"
            spellCheck={false}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
            data-testid={`${testId}-url-input`}
          />
          <Button size="sm" variant="outline" className="h-8 shrink-0 px-2 text-xs" onClick={submitUrl}>
            <Trans>Use</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}

/** A small pill that opens its own panel underneath. */
function Chip({
  label,
  icon,
  active,
  onClick,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
        active
          ? 'border-primary/50 bg-primary/10 text-foreground'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
