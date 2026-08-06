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
import { RepoPicker } from '@src/components/git/RepoPicker';
import type { ComputeNode } from '@sdk';
import type { ContextProject, SandboxSetup, Step } from '@src/hooks/use-sandboxes';
import { StepList } from '@src/components/ui/step-list';
import { Briefcase, GitBranch, Github, Link2, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * A picked source, normalised at pick time.
 *
 * `gitOrigin` is null for a project that was never cloned from anywhere — it
 * can still be the project the sandbox loads (the box mounts it empty), but it
 * has nothing to clone as an asset. `projectId` is set when the user picked an
 * existing project rather than pasting a URL, and is what the box adopts so one
 * id spans hub and sandbox.
 */
interface Source {
  name: string;
  gitOrigin: GitOrigin | null;
  projectId?: string;
}

/** Which chip's panel is open, if any. */
type Panel = 'project' | 'github' | 'url';

/** Which field owns the one open panel. */
interface OpenPanel {
  field: string;
  panel: Panel;
}

function sourceFromProject(project: Project): Source {
  return { name: project.displayName, gitOrigin: project.git_origin ?? null, projectId: project.id };
}

interface NewSandboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  /** Pre-fill the project to load from a repo URL (e.g. a ?setup_git= deep link). */
  initialGitUrl?: string;
  /** The project the user is working on — loaded unless they change it. */
  currentProject?: Project | null;
  /** Everything they could load instead, and everything they can add as an asset. */
  projects?: Project[];
  /**
   * Provision the box. Resolves with the created node, or rejects.
   *
   * Deliberately NOT fire-and-forget any more: the dialog stays open across the
   * call so it can report what happened, which means it has to be able to await
   * the outcome. It also must not open anything — that is the user's next click.
   */
  onCreate: (opts: { name: string; sandboxProject?: SandboxSetup }) => Promise<ComputeNode | null>;
  /** Open a created box. Called from the dialog's own Launch click, so the tab
   *  is claimed inside a real user gesture. */
  onOpen: (node: ComputeNode) => void;
  /** Live progress rows for the create in flight. */
  steps: Step[];
}

/**
 * Start a sandbox: name it, say which project it loads, and add any asset
 * packages — help desks or skills repos that get cloned in, indexed, and
 * attached as context folders of that project.
 *
 * Three states, and the dialog stays open across all of them:
 *
 *   idle     Cancel | Create
 *   creating the progress checklist, inline
 *   created  Done | Launch
 *
 * It used to close on click and fire the launch at the page behind it, which
 * put the progress rows and any failure somewhere the user was no longer
 * looking — a create that failed simply appeared to do nothing. Staying open is
 * what makes the outcome visible, and it is also what removes the popup-blocker
 * workaround: the open now happens on the Launch click, so there is no
 * placeholder tab to claim up front and none to close on error.
 *
 * Both fields are the same control ({@link SourceField}): the picks as
 * removable pills, then a chip per way in — pick a project, browse GitHub,
 * paste a URL — each opening its own panel directly underneath. The only
 * difference is what a pick does (replace vs. append) and which projects are
 * on offer.
 *
 * Only ONE panel is open across the whole dialog, which is why the open-panel
 * state lives here rather than in each field: the GitHub panel carries the repo
 * table (and, unconnected, the Connect button), and two of those stacked would
 * both bury the footer and offer the same connection twice.
 *
 * It deliberately does NOT probe repo access first: that probe
 * (`/api/v1/git/remote-access`) is a flow_sdk route the hub does not register,
 * so it 404s for every repo and asked people to connect GitHub for public ones.
 * The clone step reports the real failure.
 */
export function NewSandboxDialog({
  open,
  onOpenChange,
  defaultName,
  initialGitUrl,
  currentProject,
  projects,
  onCreate,
  onOpen,
  steps,
}: NewSandboxDialogProps) {
  const { t } = useLingui();
  const [name, setName] = useState(defaultName);
  const [loadedProject, setLoadedProject] = useState<Source | null>(null);
  const [assets, setAssets] = useState<Source[]>([]);
  const [githubConnected, setGithubConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [openPanel, setOpenPanel] = useState<OpenPanel | null>(null);
  // idle -> creating -> created. The dialog stays mounted across all three, so a
  // failure lands back on `idle` with the error visible rather than behind a
  // dialog that already closed.
  const [phase, setPhase] = useState<'idle' | 'creating' | 'created'>('idle');
  const [created, setCreated] = useState<ComputeNode | null>(null);
  const [error, setError] = useState('');

  // Reset on OPEN only. `defaultName` changes whenever the sandbox list refetches
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
    setOpenPanel(null);
    setError('');
    // Reopening starts a NEW sandbox. Without this the dialog would come back up
    // on the `created` phase, showing Done/Launch for the box made last time.
    setPhase('idle');
    setCreated(null);

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

  // Listened to for as long as the dialog is mounted, NOT only while a connect
  // is pending: gating it on `connecting` would mean the moment we stop waiting
  // (see below) a grant that does land is thrown away.
  useOAuthFlowComplete(OAUTH_PROVIDERS.GITHUB, (msg) => {
    setConnecting(false);
    if (msg.status === OAuthStatus.SUCCESS) setGithubConnected(true);
    else setError(t`GitHub connection failed.`);
  });

  const onInvalidUrl = useCallback(() => setError(t`Enter a valid GitHub repository URL.`), [t]);

  const handleCreate = useCallback(async () => {
    // Guard the double click here as well as in the hook: the hook's ref stops a
    // second box being provisioned, but only disabling the button stops the
    // second click reading as "nothing happened".
    if (phase !== 'idle') return;
    const sandboxName = name.trim() || defaultName;
    // Scope is `shared` for asset packages: they travel with the project.
    const contextProjects: ContextProject[] = assets.flatMap((asset) =>
      asset.gitOrigin ? [{ gitOrigin: asset.gitOrigin, name: asset.name, scope: 'shared' as const }] : [],
    );
    const opts = loadedProject
      ? {
          name: sandboxName,
          sandboxProject: {
            name: loadedProject.name,
            ...(loadedProject.gitOrigin ? { gitOrigin: loadedProject.gitOrigin } : {}),
            ...(loadedProject.projectId ? { projectId: loadedProject.projectId } : {}),
            ...(contextProjects.length ? { contextProjects } : {}),
          },
        }
      : { name: sandboxName }; // nothing to load → a plain sandbox

    setPhase('creating');
    setError('');
    try {
      const node = await onCreate(opts);
      if (!node) {
        // The hook refused because a create was already in flight. Nothing was
        // provisioned, so this is not an error state to report — just go back.
        setPhase('idle');
        return;
      }
      setCreated(node);
      setPhase('created');
    } catch (e) {
      // Back to idle, dialog still open, message on screen: the user can fix the
      // input and try again without rebuilding their picks.
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }, [phase, name, defaultName, loadedProject, assets, onCreate]);

  const handleLaunch = useCallback(() => {
    if (!created) return;
    // Inside the click gesture, with the final URL — the whole reason the
    // placeholder-tab workaround could be deleted.
    onOpen(created);
    onOpenChange(false);
  }, [created, onOpen, onOpenChange]);

  return (
    /* Closing is never conditional. `connecting` clears only when an
       OAUTH_FLOW_COMPLETE arrives, and that event may never come — the user
       shuts the popup, or the message lands with no matching flow id and
       oauth-service returns without emitting. Gating dismissal on it turned an
       abandoned connect into a dialog with no way out: Escape and the overlay
       swallowed, Cancel disabled. A pending connect is a reason to spin the
       Connect button, and nothing more. */
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle><Trans>New sandbox</Trans></DialogTitle>
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
          emptyHint={t`Nothing selected — launches an empty sandbox.`}
          onInvalidUrl={onInvalidUrl}
          panel={openPanel?.field === 'loaded-project' ? openPanel.panel : null}
          onPanelChange={(panel) => setOpenPanel(panel ? { field: 'loaded-project', panel } : null)}
          githubConnected={githubConnected}
          connecting={connecting}
          onConnectGithub={connectGithub}
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
          panel={openPanel?.field === 'assets' ? openPanel.panel : null}
          onPanelChange={(panel) => setOpenPanel(panel ? { field: 'assets', panel } : null)}
          githubConnected={githubConnected}
          connecting={connecting}
          onConnectGithub={connectGithub}
        />

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        {/* Progress lives INSIDE the dialog now. It used to render on the page
            behind a dialog that had already closed, which is where failures went
            to be missed. */}
        {phase !== 'idle' && (
          <div className="mt-3" data-testid="sandbox-create-steps">
            <StepList steps={steps} />
          </div>
        )}

        <DialogFooter className="mt-4">
          {phase === 'created' ? (
            <>
              {/* Done, not Cancel: the box exists either way. Closing here keeps
                  it — it is in the list on the page behind. */}
              <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="done-sandbox">
                <Trans>Done</Trans>
              </Button>
              <Button onClick={handleLaunch} data-testid="launch-sandbox">
                <Trans>Launch</Trans>
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={phase === 'creating'}>
                <Trans>Cancel</Trans>
              </Button>
              {/* A half-finished connection doesn't block a create either: the
                  source is already chosen, and GitHub only ever mattered for
                  reaching a private repo. */}
              <Button
                onClick={() => void handleCreate()}
                disabled={phase === 'creating'}
                data-testid="create-sandbox"
              >
                {phase === 'creating' && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                <Trans>Create</Trans>
              </Button>
            </>
          )}
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
 * and its consequence stay in one place; which panel is open is the caller's
 * state, because only one is open across the whole dialog.
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
  panel,
  onPanelChange,
  githubConnected,
  connecting,
  onConnectGithub,
}: {
  label: string;
  testId: string;
  projects: Project[];
  values: Source[];
  onPick: (source: Source) => void;
  onRemove: (index: number) => void;
  emptyHint: string;
  onInvalidUrl: () => void;
  panel: Panel | null;
  onPanelChange: (panel: Panel | null) => void;
  githubConnected: boolean;
  connecting: boolean;
  onConnectGithub: () => void;
}) {
  const { t } = useLingui();
  const [url, setUrl] = useState('');
  const togglePanel = (next: Panel) => onPanelChange(panel === next ? null : next);

  const pickedIds = useMemo(
    () => values.map((v) => v.projectId).filter((id): id is string => !!id),
    [values],
  );

  const pick = (source: Source) => {
    onPanelChange(null);
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

      {/* The three ways in, always all three. Hiding the project chip when the
          list happened to be empty (or fully picked) made the field look like
          git was the only way to name a source — on a fresh hub account, which
          has no projects yet, that is exactly when it misleads. The panel's own
          empty state says "no projects" far more honestly than a missing chip. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          active={panel === 'project'}
          onClick={() => togglePanel('project')}
          testId={`${testId}-chip-project`}
          label={t`Select project`}
          icon={<Briefcase className="h-3 w-3" />}
        />
        <Chip
          active={panel === 'github'}
          onClick={() => togglePanel('github')}
          testId={`${testId}-chip-github`}
          label={githubConnected ? t`Browse GitHub` : t`Connect GitHub`}
          icon={<Github className="h-3 w-3" />}
        />
        <Chip
          active={panel === 'url'}
          onClick={() => togglePanel('url')}
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
            emptyMessage={t`No projects to choose from — use GitHub or a git URL.`}
            onSelect={(id) => {
              const project = projects.find((p) => p.id === id);
              if (project) pick(sourceFromProject(project));
            }}
          />
        </div>
      )}

      {/* Connected, this is the repo table; unconnected it is the one place the
          connection is offered, so the chip that promises repos is also what
          gets you them. `githubConnected` is the dialog's state, so finishing
          OAuth swaps this panel to the picker with nothing else to click. */}
      {panel === 'github' && (
        <div className="mt-1.5 rounded-md border border-border p-2" data-testid={`${testId}-github`}>
          {githubConnected ? (
            <RepoPicker
              provider="github"
              onSelect={(repo) => pick({ name: repo.name, gitOrigin: repo.git_origin })}
            />
          ) : (
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                <Trans>Connect GitHub to pick from your repos, including private ones.</Trans>
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 shrink-0 px-2 text-xs"
                onClick={onConnectGithub}
                disabled={connecting}
                data-testid="connect-github"
              >
                {connecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Github className="h-3 w-3" />}
                <span className="ml-1.5"><Trans>Connect</Trans></span>
              </Button>
            </div>
          )}
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
