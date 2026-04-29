import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useClaudeProjectList, getProjectDisplayName } from '@src/hooks/use-claude-projects';
import {
  ContextEntitiesEnum,
  dataContext,
  FLOWPAD_ASSISTANT_PROJECT_UNAME,
  type ProjectListItem,
  Project,
  QueryRequest,
} from '@sdk';
import apiClient from '@sdk/client';
import {
  applyProjectToTask,
  persistRemoteToLocalMapping,
} from '@src/components/conversation/apply-project-choice';
import { useProject } from '@sdk/react/hooks';
import { useDevMode } from '@src/contexts/dev-mode-context';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { useToast } from '@src/hooks/use-toast';
import { Check, FolderOpen, FolderPlus, Loader2, Lock, Search, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const SHOW_SYSTEM_PROJECTS_KEY = 'project-list-show-system';

function loadShowSystemFlag(): boolean {
  try { return localStorage.getItem(SHOW_SYSTEM_PROJECTS_KEY) === 'true'; } catch { return false; }
}

function saveShowSystemFlag(v: boolean) {
  try { localStorage.setItem(SHOW_SYSTEM_PROJECTS_KEY, v ? 'true' : 'false'); } catch {}
}

type TimeFilter = 'today' | 'week' | 'all';
const TIME_FILTER_KEY = 'project-list-time-filter';

function loadTimeFilter(): TimeFilter {
  try {
    const v = localStorage.getItem(TIME_FILTER_KEY);
    if (v === 'today' || v === 'week' || v === 'all') return v;
  } catch {}
  return 'week';
}

function saveTimeFilter(v: TimeFilter) {
  try { localStorage.setItem(TIME_FILTER_KEY, v); } catch {}
}

function cutoffForFilter(filter: TimeFilter): Date | null {
  if (filter === 'all') return null;
  const d = new Date();
  if (filter === 'today') { d.setHours(0, 0, 0, 0); return d; }
  d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return d;
}

/** null modified_at → treat as now (always passes any time filter) */
function effectiveModifiedAt(iso: string | null | undefined): Date {
  if (!iso) return new Date();
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date() : d;
}

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return null;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

const normalizePath = (path: string): string => {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
};

const canonicalPathKey = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  return normalized.replace(/^\/+/, '') || normalized;
};

const getProjectPath = (project: Project): string => normalizePath(project.fs_storage_mount_path || project.name || '');

// ---------------------------------------------------------------------------
// ProjectSelectList
// ---------------------------------------------------------------------------

interface ProjectSelectListProps {
  projects: ProjectListItem[];
  isLoading: boolean;
  currentProjectPath: string;
  openingProjectId: string | null;
  isSubmitting: boolean;
  onProjectClick: (project: ProjectListItem) => void;
  showSystem: boolean;
  onShowSystemChange: (next: boolean) => void;
  devMode: boolean;
}

const TIME_FILTER_LABELS: { value: TimeFilter; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'all', label: 'All' },
];

function ProjectSelectList({
  projects,
  isLoading,
  currentProjectPath,
  openingProjectId,
  isSubmitting,
  onProjectClick,
  showSystem,
  onShowSystemChange,
  devMode,
}: ProjectSelectListProps) {
  const [search, setSearch] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(loadTimeFilter);

  const handleTimeFilter = (v: TimeFilter) => {
    setTimeFilter(v);
    saveTimeFilter(v);
  };

  const countForFilter = useMemo(
    () => (f: TimeFilter) => {
      const cutoff = cutoffForFilter(f);
      return projects.filter((p) => !cutoff || effectiveModifiedAt(p.modified_at) >= cutoff).length;
    },
    [projects],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = cutoffForFilter(timeFilter);
    return projects.filter((p) => {
      if (cutoff && effectiveModifiedAt(p.modified_at) < cutoff) return false;
      if (!q) return true;
      return getProjectDisplayName(p).toLowerCase().includes(q) || (p.cwd ?? '').toLowerCase().includes(q);
    });
  }, [projects, search, timeFilter]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="flex items-center rounded-md border border-border bg-muted p-0.5">
          {TIME_FILTER_LABELS.map(({ value, label }) => {
            const count = countForFilter(value);
            const active = timeFilter === value;
            return (
              <button
                key={value}
                onClick={() => handleTimeFilter(value)}
                className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors ${active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
                <span className={`rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums ${active ? 'bg-muted text-foreground' : 'bg-background/80 text-muted-foreground border border-border'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <label
          className="ml-1 flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Show SDK-shipped system projects (Flowpad Assistant)"
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-input"
            checked={showSystem}
            onChange={(e) => onShowSystemChange(e.target.checked)}
          />
          Show system
        </label>
      </div>
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-card">
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading projects...
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {projects.length === 0 ? 'No projects found' : 'No matches'}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {filtered.map((project) => {
            const projectPath = normalizePath(project.cwd || project.name || '');
            const isCurrent = !!currentProjectPath && canonicalPathKey(projectPath) === canonicalPathKey(currentProjectPath);
            const isOpening = openingProjectId === project.id;
            const isSystem = !!project.system;
            const isGated = isSystem && !devMode;

            return (
              <button
                key={project.id}
                onClick={() => !isGated && onProjectClick(project)}
                disabled={!!openingProjectId || isSubmitting || isGated}
                title={
                  isGated
                    ? `${getProjectDisplayName(project)} — dev mode required to open`
                    : project.cwd ? `${getProjectDisplayName(project)}\n${project.cwd}` : getProjectDisplayName(project)
                }
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${isGated ? '' : 'hover:bg-accent/50'} ${isCurrent ? 'bg-accent/30' : ''}`}
              >
                {isOpening ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : isGated ? (
                  <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : isCurrent ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                ) : (
                  <div className="h-3.5 w-3.5 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{getProjectDisplayName(project)}</span>
                    {isSystem && (
                      <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                        <Sparkles className="h-2.5 w-2.5" />
                        system
                      </span>
                    )}
                  </div>
                  {project.cwd && (
                    <div className="truncate font-mono text-xs text-muted-foreground">{project.cwd}</div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  {project.session_count > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {project.session_count} session{project.session_count !== 1 ? 's' : ''}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground/70">
                    {relativeTime(project.modified_at) ?? 'today'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectSelectDialog
// ---------------------------------------------------------------------------

interface ProjectSelectDialogProps {
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
  showSystem: boolean;
  onShowSystemChange: (next: boolean) => void;
  devMode: boolean;
  /** Adapts the dialog title + description to the trigger context. */
  trigger?: 'switch' | 'map' | 'gate';
  /** Optional remote-project label shown in the description for 'map' trigger. */
  remoteProjectName?: string;
}

function ProjectSelectDialog({
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
  showSystem,
  onShowSystemChange,
  devMode,
  trigger = 'switch',
  remoteProjectName,
}: ProjectSelectDialogProps) {
  const title =
    trigger === 'map'
      ? 'Map remote project'
      : trigger === 'gate'
      ? 'Pick a project'
      : 'Projects';
  const description =
    trigger === 'map'
      ? remoteProjectName
        ? `This conversation came from a project called "${remoteProjectName}" on another machine. Pick the local project folder it should map to.`
        : 'This conversation came from a project on another machine. Pick the local project folder it should map to.'
      : trigger === 'gate'
      ? "Pick the local project folder this conversation should run in. We'll use it as the working directory for Claude Code sessions."
      : 'Select a project or open a new folder.';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto pr-1">
          <ProjectSelectList
            projects={projects}
            isLoading={isLoadingProjects}
            currentProjectPath={currentProjectPath}
            openingProjectId={openingProjectId}
            isSubmitting={isSubmitting}
            onProjectClick={onProjectClick}
            showSystem={showSystem}
            onShowSystemChange={onShowSystemChange}
            devMode={devMode}
          />

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={onOpenFolder}
              disabled={!computeNodeAvailable || isSubmitting || !!openingProjectId}
            >
              <FolderOpen className="h-4 w-4" />
              Open Folder
            </Button>
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={onCreateNew}
              disabled={isSubmitting || !!openingProjectId}
            >
              <FolderPlus className="h-4 w-4" />
              Create New
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
      setError('Please fill in both fields');
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
          <DialogTitle>Create New Project</DialogTitle>
          <DialogDescription>Enter a name and choose a parent folder for the new project.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="new-project-name">Project name</Label>
            <Input
              id="new-project-name"
              placeholder="my-awesome-project"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-parent-folder">Parent folder</Label>
            <div className="flex gap-2">
              <Input
                id="new-parent-folder"
                value={parentFolder}
                onChange={(e) => setParentFolder(e.target.value)}
                placeholder={defaultWorkspacePath || 'Select parent folder'}
                className="flex-1 font-mono text-sm"
                dir="ltr"
              />
              {computeNodeAvailable && (
                <Button variant="outline" onClick={() => void pickFolder(parentFolder || defaultWorkspacePath || undefined).then((p) => { if (p) setParentFolder(p); })} type="button" title="Browse">
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
                Creating...
              </>
            ) : (
              'Create Project'
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
  const { project: currentProject } = useProject();
  const { toast } = useToast();
  const { projects: scanProjects, isLoading: isLoadingScanProjects } = useClaudeProjectList({ enabled: open });
  const { computeNode } = useAgentContext();

  const [showCreate, setShowCreate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flowpadProjects, setFlowpadProjects] = useState<Project[]>([]);
  const [systemProjects, setSystemProjects] = useState<{ id: string; name: string; uname?: string; fs_storage_mount_path?: string; displayName?: string }[]>([]);
  const [showSystem, setShowSystem] = useState<boolean>(loadShowSystemFlag);
  const devMode = useDevMode();

  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);

  const handleShowSystemChange = useCallback((next: boolean) => {
    setShowSystem(next);
    saveShowSystemFlag(next);
  }, []);

  useEffect(() => {
    if (!open) {
      setShowCreate(false);
      setError(null);
      setIsSubmitting(false);
      setOpeningProjectId(null);
      return;
    }
    Project.query(new QueryRequest({ type: Project.type, scope: [] }))
      .then(setFlowpadProjects)
      .catch(() => {});
  }, [open]);

  // Fetch system projects via direct HTTP (bypassing Project.query so include_system
  // lands on the top-level query string rather than inside the QueryFilter.match).
  useEffect(() => {
    if (!open || !showSystem) {
      setSystemProjects([]);
      return;
    }
    apiClient
      .get('/graph/project/?include_system=true')
      .then((data: unknown) => {
        const list = Array.isArray((data as { data?: unknown[] })?.data)
          ? ((data as { data: unknown[] }).data as Array<Record<string, unknown>>)
          : Array.isArray(data)
            ? (data as unknown as Array<Record<string, unknown>>)
            : [];
        setSystemProjects(
          list
            .filter((p) => !!p.system)
            .map((p) => ({
              id: String(p.id ?? ''),
              name: String(p.name ?? ''),
              uname: typeof p.uname === 'string' ? p.uname : undefined,
              fs_storage_mount_path: typeof p.fs_storage_mount_path === 'string' ? p.fs_storage_mount_path : undefined,
              displayName: typeof p.name === 'string' ? p.name : undefined,
            })),
        );
      })
      .catch(() => setSystemProjects([]));
  }, [open, showSystem]);

  // Merge scanned Claude projects with flowpad Project entities, then deduplicate
  // by canonical path. Scanned entries are preferred (they have real session counts
  // and filesystem timestamps). Flowpad-only entries (no Claude session yet) are
  // appended with session_count=0 and modified_at=null (treated as today by the filter).
  const mergedProjects = useMemo((): ProjectListItem[] => {
    const byPath = new Map<string, ProjectListItem>();

    const upsert = (item: ProjectListItem) => {
      const key = item.cwd ? canonicalPathKey(normalizePath(item.cwd)) : null;
      if (!key) return;
      const existing = byPath.get(key);
      // Keep entry with more sessions; on tie prefer non-null modified_at
      if (!existing || item.session_count > existing.session_count ||
          (item.session_count === existing.session_count && item.modified_at && !existing.modified_at)) {
        byPath.set(key, item);
      }
    };

    for (const p of scanProjects) upsert(p);

    for (const p of flowpadProjects) {
      const path = p.fs_storage_mount_path;
      // Skip blank, temp, internal, and session/record-path entities
      if (!path || !p.name) continue;
      if (/^\/tmp\/|^\/private\/tmp\//.test(path)) continue;
      if (/[/\\](\.flow|flow\/sessions|flow\/records)[/\\]/.test(path)) continue;
      upsert({
        id: `flowpad:${p.id}`,
        name: p.displayName,
        encoded_name: p.id,
        cwd: path,
        session_count: 0,
        modified_at: null,
      });
    }

    // System projects are only appended when the "Show system" checkbox is on.
    for (const p of systemProjects) {
      const path = p.fs_storage_mount_path;
      if (!path || !p.name) continue;
      upsert({
        id: `flowpad:${p.id}`,
        name: p.displayName || p.name,
        encoded_name: p.id,
        cwd: path,
        session_count: 0,
        modified_at: null,
        system: true,
      });
    }

    return Array.from(byPath.values());
  }, [scanProjects, flowpadProjects, systemProjects]);

  const currentProjectPath = useMemo(
    () => normalizePath(currentProject?.fs_storage_mount_path || currentProject?.name || ''),
    [currentProject],
  );

  const setCurrentProjectContext = useCallback(
    async (project: Project) => {
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
      await dataContext.refreshProject();
      dataContext.setWorkdir(project.fs_storage_mount_path ?? null);

      // Optional side-effects when the dialog was opened via the gate /
      // mapping flow. Both are no-ops in the plain footer-switch case.
      if (taskId) await applyProjectToTask(taskId, project);
      if (remoteProjectId) await persistRemoteToLocalMapping(remoteProjectId, project.id ?? null);

      onProjectChanged?.();
      try {
        await onPicked?.(project);
      } catch {
        // continuation errors shouldn't break the picker
      }
    },
    [onProjectChanged, taskId, remoteProjectId, onPicked],
  );

  const ensureProjectAndSetContext = useCallback(
    async (path: string) => {
      if (!dataContext.someone) throw new Error('You must be logged in');

      const normalizedPath = normalizePath(path);
      if (!normalizedPath) throw new Error('Please provide a valid project path');

      const pathKey = canonicalPathKey(normalizedPath);
      const freshProjects = await Project.query(
        new QueryRequest({ type: Project.type, query: null, scope: [], name: 'open-project-dedup' }),
      );
      let targetProject = freshProjects.find((p) => canonicalPathKey(getProjectPath(p)) === pathKey) || null;
      const openedExisting = !!targetProject;

      if (!targetProject) {
        targetProject = new Project({ name: normalizedPath });
        targetProject = await targetProject.save([dataContext.someone]);
      }

      await targetProject.setupForDesktop();
      await setCurrentProjectContext(targetProject);
      return { project: targetProject, openedExisting };
    },
    [setCurrentProjectContext],
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
        setError(err instanceof Error ? err.message : 'Failed to open project');
      } finally {
        setOpeningProjectId(null);
      }
    },
    [ensureProjectAndSetContext, onOpenChange],
  );

  const pickFolder = useCallback(async (initialDir?: string): Promise<string | null> => {
    if (!computeNode) {
      setError('No compute node available');
      return null;
    }
    try {
      return await computeNode.openPathDialog(initialDir);
    } catch {
      setError('Failed to open folder picker');
      return null;
    }
  }, [computeNode]);

  const handleOpenFolder = useCallback(async () => {
    const selected = await pickFolder(defaultWorkspacePath || undefined);
    if (!selected) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const result = await ensureProjectAndSetContext(selected);
      if (result.openedExisting) {
        toast({ title: 'Opened existing project', description: result.project.displayName });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open project');
    } finally {
      setIsSubmitting(false);
    }
  }, [pickFolder, ensureProjectAndSetContext, onOpenChange, toast]);

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
      <ProjectSelectDialog
        open={open && !showCreate}
        onOpenChange={onOpenChange}
        projects={mergedProjects}
        isLoadingProjects={isLoadingScanProjects}
        currentProjectPath={currentProjectPath}
        openingProjectId={openingProjectId}
        isSubmitting={isSubmitting}
        computeNodeAvailable={!!computeNode}
        error={error}
        onProjectClick={(p) => void handleProjectClick(p)}
        onOpenFolder={() => void handleOpenFolder()}
        onCreateNew={() => setShowCreate(true)}
        showSystem={showSystem}
        onShowSystemChange={handleShowSystemChange}
        devMode={devMode}
        trigger={trigger ?? (remoteProjectId ? 'map' : taskId ? 'gate' : 'switch')}
        remoteProjectName={remoteProjectName}
      />
      <NewProjectDialog
        open={open && showCreate}
        onOpenChange={(v) => { if (!v) onOpenChange(false); }}
        defaultWorkspacePath={defaultWorkspacePath}
        computeNodeAvailable={!!computeNode}
        pickFolder={pickFolder}
        onCreate={handleCreate}
      />
    </>
  );
}

export default OpenProjectComponent;
