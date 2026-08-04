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
import { cn } from '@src/lib/utils';
import { fetchGithubStatus } from '@src/lib/github-oauth-status';
import type { ContextProject, SandboxSetup } from '@src/hooks/use-desktops';
import { Briefcase, Check, GitBranch, Github, Link2, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** What the user picked as a source — a project they already have, or a repo URL. */
type Source =
  | { kind: 'project'; project: Project }
  | { kind: 'git'; gitOrigin: GitOrigin; name: string };

/** Which chip's panel is open, if any. */
type Panel = 'project' | 'github' | 'url';

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

/** A source's git origin, when it has one. A project that was never cloned from
 *  anywhere has none — it can still be the project loaded (the box mounts it
 *  empty), but there is nothing to clone for it as an asset. */
function originOf(source: Source): GitOrigin | null {
  return source.kind === 'git' ? source.gitOrigin : (source.project.git_origin ?? null);
}

function nameOf(source: Source): string {
  return source.kind === 'git' ? source.name : (source.project.name ?? 'project');
}

/**
 * Start a desktop: name it, say which project it loads, and add any asset
 * packages — help desks or skills repos that get cloned in, indexed, and
 * attached as context folders of that project.
 *
 * Both fields are the same control ({@link SourceField}): three chips — pick a
 * project, connect GitHub, paste a URL — each opening its own panel directly
 * underneath. The only difference is what a pick does (replace vs. append) and
 * which projects are offered.
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
        ? { kind: 'git', gitOrigin: fromUrl, name: fromUrl.name }
        : currentProject
          ? { kind: 'project', project: currentProject }
          : null,
    );
    setAssets([]);
    setConnecting(false);
    setError('');
    void fetchGithubStatus().then((r) => setGithubConnected(r === true));
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

  const handleSubmit = useCallback(() => {
    const desktopName = name.trim() || defaultName;
    if (!loadedProject) {
      onOpenChange(false);
      onLaunch({ name: desktopName }); // nothing to load → a plain desktop
      return;
    }
    const origin = originOf(loadedProject);
    const contextProjects: ContextProject[] = assets.flatMap((asset) => {
      const assetOrigin = originOf(asset);
      // Scope is `shared` for asset packages: they travel with the project.
      return assetOrigin ? [{ gitOrigin: assetOrigin, name: nameOf(asset), scope: 'shared' as const }] : [];
    });
    onOpenChange(false);
    onLaunch({
      name: desktopName,
      sandboxProject: {
        name: nameOf(loadedProject),
        ...(origin ? { gitOrigin: origin } : {}),
        ...(loadedProject.kind === 'project' ? { projectId: loadedProject.project.id } : {}),
        ...(contextProjects.length ? { contextProjects } : {}),
      },
    });
  }, [name, defaultName, loadedProject, assets, onLaunch, onOpenChange]);

  const shared = {
    githubConnected,
    connecting,
    onConnect: connectGithub,
    onInvalidUrl: () => setError(t`Enter a valid GitHub repository URL.`),
  };

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
          {...shared}
        />

        <SourceField
          label={t`Additional assets`}
          testId="assets"
          projects={assetCandidates}
          values={assets}
          onPick={(source) => setAssets((prev) => [...prev, source])}
          onRemove={(index) => setAssets((prev) => prev.filter((_, at) => at !== index))}
          emptyHint={t`Help desks or skills repos to load alongside it.`}
          {...shared}
        />

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
 * One labelled field: what's picked so far, then the three ways to pick more.
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
  githubConnected,
  connecting,
  onConnect,
  onInvalidUrl,
}: {
  label: string;
  testId: string;
  projects: Project[];
  values: Source[];
  onPick: (source: Source) => void;
  onRemove: (index: number) => void;
  emptyHint: string;
  githubConnected: boolean;
  connecting: boolean;
  onConnect: () => void;
  onInvalidUrl: () => void;
}) {
  const { t } = useLingui();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [url, setUrl] = useState('');

  const toggle = (next: Panel) => setPanel((prev) => (prev === next ? null : next));

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
    pick({ kind: 'git', gitOrigin, name: gitOrigin.name });
  };

  return (
    <div className="mb-4" data-testid={`${testId}-field`}>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>

      {values.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid={`${testId}-values`}>
          {values.map((source, i) => (
            <span
              key={`${nameOf(source)}-${i}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pl-2 pr-1 text-xs"
            >
              {source.kind === 'project' ? (
                <Briefcase className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{nameOf(source)}</span>
              {!originOf(source) && (
                <span className="shrink-0 text-[10px] uppercase text-muted-foreground"><Trans>no repo</Trans></span>
              )}
              <button
                type="button"
                className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onRemove(i)}
                aria-label={t`Remove ${nameOf(source)}`}
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
        {/* Picking from a list only means something when there IS a choice. */}
        {projects.length > 1 && (
          <Chip
            active={panel === 'project'}
            onClick={() => toggle('project')}
            testId={`${testId}-chip-project`}
            label={t`Select project`}
            icon={<Briefcase className="h-3 w-3" />}
          />
        )}
        <Chip
          active={panel === 'github'}
          onClick={() => (githubConnected ? toggle('github') : onConnect())}
          testId={`${testId}-chip-github`}
          label={githubConnected ? t`GitHub connected` : t`Connect GitHub`}
          iconOnly
          icon={
            connecting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Github className={cn('h-3 w-3', githubConnected && 'text-emerald-500')} />
            )
          }
        />
        <Chip
          active={panel === 'url'}
          onClick={() => toggle('url')}
          testId={`${testId}-chip-url`}
          label={t`Git URL`}
          icon={<Link2 className="h-3 w-3" />}
        />
      </div>

      {panel === 'project' && (
        <ul className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-border p-1" data-testid={`${testId}-projects`}>
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                onClick={() => pick({ kind: 'project', project })}
              >
                <Briefcase className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{project.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {panel === 'github' && githubConnected && (
        <p className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground">
          <Check className="h-3 w-3 text-emerald-500" />
          <Trans>GitHub is connected — private repos are available.</Trans>
        </p>
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
  iconOnly,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  testId: string;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
        active
          ? 'border-primary/50 bg-primary/10 text-foreground'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {icon}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}
