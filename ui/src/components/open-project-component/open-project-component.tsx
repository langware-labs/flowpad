import { getProjectDisplayName } from '@src/hooks/use-claude-projects';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { dataContext, type ProjectListItem, Project, PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { canonicalPath } from '@src/components/project-selector';
import { normalizePath, useProjectOpener } from './use-open-project';
import { SectionHairlineTitle } from '@src/components/terminal/ProjectsCounterChip';
import { useTabProjectBuckets } from '@src/tabs/useTabs';
import { useProject } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { notify } from '@src/notifications';
import { Check, FolderOpen, FolderPlus, Loader2, Search } from 'lucide-react';
import { projectRecencyMs } from '@src/lib/project-recency';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** Free-text match against a project's display name or cwd. `q` must already be
 *  trimmed + lowercased. */
const matchesProjectQuery = (project: ProjectListItem, q: string): boolean =>
  getProjectDisplayName(project).toLowerCase().includes(q) || (project.cwd ?? '').toLowerCase().includes(q);

// ---------------------------------------------------------------------------
// CompactProjectSelectDialog — the project picker
// ---------------------------------------------------------------------------
//
// A calm one-line-per-project picker with a tiny search and minimal actions,
// used in every view mode. The 'map'/'gate' triggers swap in explanatory
// title + description copy.

interface CompactProjectSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectListItem[];
  isLoadingProjects: boolean;
  currentProjectPath: string;
  openingProjectId: string | null;
  isSubmitting: boolean;
  computeNodeAvailable: boolean;
  error: string | null;
  onProjectClick: (project: ProjectListItem) => void;
  onOpenFolder: () => void;
  onCreateNew: () => void;
  /** Adapts the dialog title + description to the trigger context. */
  trigger?: 'switch' | 'map' | 'gate';
  /** Optional remote-project label shown in the description for 'map' trigger. */
  remoteProjectName?: string;
}

/** How many recent projects the compact list shows before the rest are
 *  reachable only via search. Keeps the picker short. */
const COMPACT_PROJECT_LIMIT = 8;

function CompactProjectSelectDialog({
  open,
  onOpenChange,
  projects,
  isLoadingProjects,
  currentProjectPath,
  openingProjectId,
  isSubmitting,
  computeNodeAvailable,
  error,
  onProjectClick,
  onOpenFolder,
  onCreateNew,
  trigger = 'switch',
  remoteProjectName,
}: CompactProjectSelectDialogProps) {
  const { t } = useLingui();
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();

  const title = trigger === 'map' ? t`Map remote project` : trigger === 'gate' ? t`Pick a project` : t`Switch Project`;
  const description =
    trigger === 'map'
      ? remoteProjectName
        ? t`This conversation came from a project called "${remoteProjectName}" on another machine. Pick the local project folder it should map to.`
        : t`This conversation came from a project on another machine. Pick the local project folder it should map to.`
      : trigger === 'gate'
        ? t`Pick the local project folder this conversation should run in. We'll use it as the working directory for Claude Code sessions.`
        : null;

  // Active projects = the ones that own open tabs — the SAME source the tab
  // strip's projects chip renders, so both surfaces always agree.
  const { buckets } = useTabProjectBuckets();
  const tabCountByProjectId = useMemo(() => new Map(buckets.map((b) => [b.projectId, b.tabCount])), [buckets]);

  const { active, rest, hiddenCount } = useMemo(() => {
    const matches = (p: ProjectListItem) => !q || matchesProjectQuery(p, q);
    // Active section mirrors the chip: alphabetical by display name, id tie-break.
    const activeList = projects
      .filter((p) => tabCountByProjectId.has(p.id) && matches(p))
      .sort((a, b) => getProjectDisplayName(a).localeCompare(getProjectDisplayName(b)) || a.id.localeCompare(b.id));
    // `last_active_at` (UI-open recency) wins; session `modified_at` is the
    // fallback; fully-unknown recency sorts as "now" (new project → top).
    const now = Date.now();
    const byRecent = projects
      .filter((p) => !tabCountByProjectId.has(p.id) && matches(p))
      .map((p) => ({ p, ms: projectRecencyMs(p) ?? now }))
      .sort((a, b) => b.ms - a.ms)
      .map((r) => r.p);
    // No query → active projects always show; the rest keep the most-recent
    // cap so Standard view stays short. Querying searches all projects.
    const restList = q ? byRecent : byRecent.slice(0, COMPACT_PROJECT_LIMIT);
    return { active: activeList, rest: restList, hiddenCount: q ? 0 : byRecent.length - restList.length };
  }, [projects, q, tabCountByProjectId]);

  const filtered = useMemo(() => [...active, ...rest], [active, rest]);
  const showSearch = projects.length > COMPACT_PROJECT_LIMIT || search.length > 0;

  // One row shape for both sections; active rows carry the chip's tab-count badge.
  const renderRow = (project: ProjectListItem, tabCount?: number) => {
    const projectPath = normalizePath(project.cwd || project.name || '');
    const isCurrent = !!currentProjectPath && canonicalPath(projectPath) === canonicalPath(currentProjectPath);
    const isOpening = openingProjectId === project.id;
    return (
      <button
        key={project.id}
        onClick={() => onProjectClick(project)}
        disabled={!!openingProjectId || isSubmitting}
        title={project.cwd ? `${getProjectDisplayName(project)}\n${project.cwd}` : getProjectDisplayName(project)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${isCurrent ? 'bg-accent/30' : ''}`}
      >
        {isOpening ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : isCurrent ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <div className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{getProjectDisplayName(project)}</span>
        {tabCount !== undefined && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {tabCount}
          </span>
        )}
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-2">
          {showSearch && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t`Search projects…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>
          )}

          <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-card">
            {isLoadingProjects ? (
              <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                <Trans>Loading…</Trans>
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {projects.length === 0 ? <Trans>No projects found</Trans> : <Trans>No matches</Trans>}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {active.length > 0 && (
                  <SectionHairlineTitle testid="switch-project-active-title">
                    <Trans>Active projects</Trans>
                  </SectionHairlineTitle>
                )}
                {active.map((project) => renderRow(project, tabCountByProjectId.get(project.id)))}
                {active.length > 0 && rest.length > 0 && (
                  <SectionHairlineTitle testid="switch-project-recent-title">
                    <Trans>Recent</Trans>
                  </SectionHairlineTitle>
                )}
                {rest.map((project) => renderRow(project))}
              </div>
            )}
          </div>

          {hiddenCount > 0 && (
            <p className="px-1 text-[11px] text-muted-foreground">
              <Trans>+{hiddenCount} more — search to find them</Trans>
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5"
              onClick={onOpenFolder}
              disabled={!computeNodeAvailable || isSubmitting || !!openingProjectId}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <Trans>Open Folder</Trans>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5"
              onClick={onCreateNew}
              disabled={isSubmitting || !!openingProjectId}
            >
              <FolderPlus className="h-3.5 w-3.5" />
              <Trans>Create New</Trans>
            </Button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// NewProjectDialog
// ---------------------------------------------------------------------------

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultWorkspacePath: string;
  computeNodeAvailable: boolean;
  pickFolder: (initialDir?: string) => Promise<string | null>;
  onCreate: (name: string, parentFolder: string) => Promise<void>;
}

function NewProjectDialog({
  open,
  onOpenChange,
  defaultWorkspacePath,
  computeNodeAvailable,
  pickFolder,
  onCreate,
}: NewProjectDialogProps) {
  const { t } = useLingui();
  const [projectName, setProjectName] = useState('');
  const [parentFolder, setParentFolder] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProjectName('');
    setParentFolder(defaultWorkspacePath);
    setError(null);
    setIsSubmitting(false);
  }, [open, defaultWorkspacePath]);

  const handleCreate = useCallback(async () => {
    if (!projectName.trim() || !parentFolder.trim()) {
      setError(t`Please fill in both fields`);
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await onCreate(projectName.trim(), parentFolder.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setIsSubmitting(false);
    }
  }, [projectName, parentFolder, onCreate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Trans>Create New Project</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Enter a name and choose a parent folder for the new project.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="new-project-name">
              <Trans>Project name</Trans>
            </Label>
            <Input
              id="new-project-name"
              placeholder={t`my-awesome-project`}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-parent-folder">
              <Trans>Parent folder</Trans>
            </Label>
            <div className="flex gap-2">
              <Input
                id="new-parent-folder"
                value={parentFolder}
                onChange={(e) => setParentFolder(e.target.value)}
                placeholder={defaultWorkspacePath || t`Select parent folder`}
                className="flex-1 font-mono text-sm"
                dir="ltr"
              />
              {computeNodeAvailable && (
                <Button
                  variant="outline"
                  onClick={() =>
                    void pickFolder(parentFolder || defaultWorkspacePath || undefined).then((p) => {
                      if (p) setParentFolder(p);
                    })
                  }
                  type="button"
                  title={t`Browse`}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            className="w-full"
            onClick={() => void handleCreate()}
            disabled={isSubmitting || !projectName.trim() || !parentFolder.trim()}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                <Trans>Creating...</Trans>
              </>
            ) : (
              <Trans>Create Project</Trans>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// OpenProjectComponent — orchestrator
// ---------------------------------------------------------------------------

interface OpenProjectComponentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectChanged?: () => void;
  /** When set, the picked project is also stamped onto this task's metadata
   *  (project_id / project_name / project_root) so subsequent task-bound
   *  actions know which folder to use. */
  taskId?: string;
  /** When set + non-empty, a remote→local entry is written to the per-machine
   *  mapping table so future messages from the same remote project auto-route
   *  to the picked local one. */
  remoteProjectId?: string | null;
  /** Optional remote-project label, shown in the description for the 'map' trigger. */
  remoteProjectName?: string;
  /** Hint that adapts the dialog copy to the surrounding flow:
   *  'switch' (default — footer), 'map' (we have a remote project to record),
   *  'gate' (action needs a project to proceed). */
  trigger?: 'switch' | 'map' | 'gate';
  /** Called after the project has been picked + side-effects applied. The
   *  gate uses this to resume the action that opened the dialog. */
  onPicked?: (project: Project) => void | Promise<void>;
}

export function OpenProjectComponent({
  open,
  onOpenChange,
  onProjectChanged,
  taskId,
  remoteProjectId,
  remoteProjectName,
  trigger,
  onPicked,
}: OpenProjectComponentProps) {
  const { t } = useLingui();
  const { project: currentProject } = useProject();

  const [showCreate, setShowCreate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSystem] = usePreference<boolean>(PrefKey.SHOW_SYSTEM_PROJECTS);

  // The open/switch flow lives in ONE place — useProjectOpener — shared with
  // the vibe home hero buttons, so surface-derived behavior (stay on home,
  // resume a process, resume the last tab) can't drift between call sites.
  // The dialog owns only its UI state (busy flags, error, close-on-success).
  const { computeNode, ensureProjectAndSetContext, pickFolder } = useProjectOpener({
    onProjectChanged,
    onPicked,
    onError: setError,
  });

  const resolvedTrigger = trigger ?? (remoteProjectId ? 'map' : taskId ? 'gate' : 'switch');

  const { projects: mergedProjects, isLoading: isLoadingScanProjects } = useAllProjects({
    enabled: open,
    includeSystem: showSystem,
  });

  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);

  useEffect(() => {
    if (!open) {
      setShowCreate(false);
      setError(null);
      setIsSubmitting(false);
      setOpeningProjectId(null);
    }
  }, [open]);

  const currentProjectPath = useMemo(
    () => normalizePath(currentProject?.fs_storage_mount_path || currentProject?.name || ''),
    [currentProject],
  );

  const handleProjectClick = useCallback(
    async (project: ProjectListItem) => {
      const path = normalizePath(project.cwd || project.name || '');
      if (!path) return;

      setOpeningProjectId(project.id);
      setError(null);
      try {
        await ensureProjectAndSetContext(path);
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t`Failed to open project`);
      } finally {
        setOpeningProjectId(null);
      }
    },
    [ensureProjectAndSetContext, onOpenChange, t],
  );

  const handleOpenFolder = useCallback(async () => {
    const selected = await pickFolder(defaultWorkspacePath || undefined);
    if (!selected) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const result = await ensureProjectAndSetContext(selected);
      if (result.openedExisting) {
        notify.success({ title: t`Opened existing project`, message: result.project.displayName });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Failed to open project`);
    } finally {
      setIsSubmitting(false);
    }
  }, [pickFolder, ensureProjectAndSetContext, onOpenChange, t]);

  // NewProjectDialog calls this after validation
  const handleCreate = useCallback(
    async (name: string, parentFolder: string) => {
      const fullPath = `${normalizePath(parentFolder)}/${name}`;
      await ensureProjectAndSetContext(fullPath);
      onOpenChange(false);
    },
    [ensureProjectAndSetContext, onOpenChange],
  );

  return (
    <>
      <CompactProjectSelectDialog
        open={open && !showCreate}
        onOpenChange={onOpenChange}
        projects={mergedProjects}
        isLoadingProjects={isLoadingScanProjects}
        currentProjectPath={currentProjectPath}
        openingProjectId={openingProjectId}
        isSubmitting={isSubmitting}
        computeNodeAvailable={!!computeNode}
        error={error}
        onProjectClick={(p: ProjectListItem) => void handleProjectClick(p)}
        onOpenFolder={() => void handleOpenFolder()}
        onCreateNew={() => setShowCreate(true)}
        trigger={resolvedTrigger}
        remoteProjectName={remoteProjectName}
      />
      <NewProjectDialog
        open={open && showCreate}
        onOpenChange={(v) => {
          if (!v) onOpenChange(false);
        }}
        defaultWorkspacePath={defaultWorkspacePath}
        computeNodeAvailable={!!computeNode}
        pickFolder={pickFolder}
        onCreate={handleCreate}
      />
    </>
  );
}

export default OpenProjectComponent;
