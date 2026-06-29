import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { getProjectDisplayName } from '@src/hooks/use-claude-projects';
import { useAllProjects } from '@src/hooks/use-all-projects';
import {
  dataContext,
  type ProjectListItem,
  Project,
  QueryRequest,
} from '@sdk';
import { selectProjectContext } from '@src/components/project-selector';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SCOPE_SEEDED_VIEWS } from '@src/navigation/NavigationActions';
import { projectScope } from '@src/lib/scope-filter';
import { dockForProjectEntry } from '@src/tabs/project-entry';
import { useProject } from '@sdk/react/hooks';
import { useDevMode } from '@src/contexts/dev-mode-context';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { notify } from '@src/notifications';
import { Check, FolderOpen, FolderPlus, Loader2, Lock, Search, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

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

/** Free-text match against a project's display name or cwd. `q` must already be
 *  trimmed + lowercased. Shared by the detailed and compact pickers so their
 *  search heuristic can't drift apart. */
const matchesProjectQuery = (project: ProjectListItem, q: string): boolean =>
  getProjectDisplayName(project).toLowerCase().includes(q) || (project.cwd ?? '').toLowerCase().includes(q);

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
  const { t } = useLingui();
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
      return !q || matchesProjectQuery(p, q);
    });
  }, [projects, search, timeFilter]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder={t`Search projects…`}
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
          title={t`Show SDK-shipped system projects (Flowpad Assistant)`}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-input"
            checked={showSystem}
            onChange={(e) => onShowSystemChange(e.target.checked)}
          />
          <Trans>Show system</Trans>
        </label>
      </div>
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-card">
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          <Trans>Loading projects...</Trans>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {projects.length === 0 ? <Trans>No projects found</Trans> : <Trans>No matches</Trans>}
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
                    {project.claude && (
                      <ClaudeIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" aria-label={t`Claude project`} />
                    )}
                    {project.codex && (
                      <CodexIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-label={t`Codex project`} />
                    )}
                    {project.copilot && (
                      <CopilotIcon className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-label={t`Copilot project`} />
                    )}
                    <span className="truncate font-medium">{getProjectDisplayName(project)}</span>
                    {isSystem && (
                      <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                        <Sparkles className="h-2.5 w-2.5" />
                        <Trans>system</Trans>
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
                    {relativeTime(project.modified_at) ?? t`today`}
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
  const { t } = useLingui();
  const title =
    trigger === 'map'
      ? t`Map remote project`
      : trigger === 'gate'
      ? t`Pick a project`
      : t`Projects`;
  const description =
    trigger === 'map'
      ? remoteProjectName
        ? t`This conversation came from a project called "${remoteProjectName}" on another machine. Pick the local project folder it should map to.`
        : t`This conversation came from a project on another machine. Pick the local project folder it should map to.`
      : trigger === 'gate'
      ? t`Pick the local project folder this conversation should run in. We'll use it as the working directory for Claude Code sessions.`
      : t`Select a project or open a new folder.`;
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
              <Trans>Open Folder</Trans>
            </Button>
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={onCreateNew}
              disabled={isSubmitting || !!openingProjectId}
            >
              <FolderPlus className="h-4 w-4" />
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
// CompactProjectSelectDialog — Standard-view footer switcher
// ---------------------------------------------------------------------------
//
// Standard view gets a shortened, compact project list instead of the detailed
// modal (search + time-filter pills + system toggle + per-row paths/sessions).
// Just a calm one-line-per-project picker with a tiny search and minimal
// actions. Advanced/Dev view keeps the full ProjectSelectDialog above.

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
}

/** How many recent projects the compact list shows before the rest are
 *  reachable only via search. Keeps Standard view short. */
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
}: CompactProjectSelectDialogProps) {
  const { t } = useLingui();
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    const byRecent = [...projects].sort(
      (a, b) => effectiveModifiedAt(b.modified_at).getTime() - effectiveModifiedAt(a.modified_at).getTime(),
    );
    // No query → show only the most-recent slice; querying searches all projects.
    return q ? byRecent.filter((p) => matchesProjectQuery(p, q)) : byRecent.slice(0, COMPACT_PROJECT_LIMIT);
  }, [projects, q]);

  // Without a query the list is capped; surface how many recent projects are hidden.
  const hiddenCount = q ? 0 : Math.max(0, projects.length - filtered.length);
  const showSearch = projects.length > COMPACT_PROJECT_LIMIT || search.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base"><Trans>Switch Project</Trans></DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {showSearch && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
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
                {filtered.map((project) => {
                  const projectPath = normalizePath(project.cwd || project.name || '');
                  const isCurrent =
                    !!currentProjectPath && canonicalPathKey(projectPath) === canonicalPathKey(currentProjectPath);
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
                      <span className="truncate font-medium">{getProjectDisplayName(project)}</span>
                    </button>
                  );
                })}
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
          <DialogTitle><Trans>Create New Project</Trans></DialogTitle>
          <DialogDescription><Trans>Enter a name and choose a parent folder for the new project.</Trans></DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="new-project-name"><Trans>Project name</Trans></Label>
            <Input
              id="new-project-name"
              placeholder={t`my-awesome-project`}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-parent-folder"><Trans>Parent folder</Trans></Label>
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
                <Button variant="outline" onClick={() => void pickFolder(parentFolder || defaultWorkspacePath || undefined).then((p) => { if (p) setParentFolder(p); })} type="button" title={t`Browse`}>
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
  /** Plain switch only: change the active-project CONTEXT without navigating
   *  (no project tab/dock is opened). Used by the footer "Switch Project" so
   *  switching projects doesn't pull focus into a project view. */
  contextOnly?: boolean;
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
  contextOnly,
}: OpenProjectComponentProps) {
  const { t } = useLingui();
  const { project: currentProject } = useProject();
  const { computeNode } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();

  const [showCreate, setShowCreate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState<boolean>(loadShowSystemFlag);
  const devMode = useDevMode();
  const isAdvanced = useIsAdvanced();

  // The detailed picker (search + time pills + system toggle + per-row metadata)
  // is an Advanced-view affordance. In Standard view the footer "Switch Project"
  // gets a shortened, compact list instead. Only the plain 'switch' trigger is
  // compacted — the 'map'/'gate' flows need their explanatory copy + full list.
  const resolvedTrigger = trigger ?? (remoteProjectId ? 'map' : taskId ? 'gate' : 'switch');
  const useCompact = !isAdvanced && resolvedTrigger === 'switch';

  const { projects: mergedProjects, isLoading: isLoadingScanProjects } = useAllProjects({
    enabled: open,
    includeSystem: showSystem,
  });

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
    }
  }, [open]);

  const currentProjectPath = useMemo(
    () => normalizePath(currentProject?.fs_storage_mount_path || currentProject?.name || ''),
    [currentProject],
  );

  const setCurrentProjectContext = useCallback(
    async (project: Project) => {
      await selectProjectContext(project);

      onProjectChanged?.();
      if (onPicked) {
        // Entity stamping (task/conversation/project_id, mapping table writes,
        // remap navigation) happens inside `onPicked` — the gate's apply
        // callback owns it (and its own navigation) so the wasReplacement
        // signal isn't clobbered by a pre-stamp here.
        try {
          await onPicked(project);
        } catch {
          // continuation errors shouldn't break the picker
        }
      } else if (!contextOnly) {
        // Plain switch: select the project by navigating to its tab — the same
        // path as clicking that tab (dockForProjectEntry → fromTabHash →
        // openDock). Resumes the last-active tab, or the project landing when it
        // has no open tab. Without this the active project changed but the URL
        // stayed on the old project's tab, so nothing was selected.
        navigation.openDock(await dockForProjectEntry(project.id));
      } else if (
        // contextOnly (footer Switch Project) deliberately does NOT open a
        // project tab — it just flips the active-project context. But a
        // scope-seeded view (assets/triggers/files) reads its project from the
        // URL's `scope-*`, which OUTRANKS the active project — so without this
        // its counts/lists stay pinned to the old project until a manual scope
        // change. When the current view is project-scoped, re-scope it IN PLACE
        // to the new project (same view, no focus pull — exactly like the scope
        // bar) so the URL follows the switch. A deliberate all/user scope is
        // left untouched; only an already-project-scoped view follows along.
        currentDock &&
        SCOPE_SEEDED_VIEWS.has(currentDock.viewType) &&
        currentDock.scopeFilter?.mode === 'project' &&
        currentDock.scopeFilter.activeProjectId !== project.id
      ) {
        navigation.openDock(currentDock.withScopeFilter(projectScope(project.id)));
      }
    },
    [onProjectChanged, onPicked, navigation, currentDock, contextOnly],
  );

  const ensureProjectAndSetContext = useCallback(
    async (path: string) => {
      if (!dataContext.someone) throw new Error(t`You must be logged in`);

      const normalizedPath = normalizePath(path);
      if (!normalizedPath) throw new Error(t`Please provide a valid project path`);

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
    [setCurrentProjectContext, t],
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

  const pickFolder = useCallback(async (initialDir?: string): Promise<string | null> => {
    if (!computeNode) {
      setError(t`No compute node available`);
      return null;
    }
    try {
      return await computeNode.openPathDialog(initialDir);
    } catch {
      setError(t`Failed to open folder picker`);
      return null;
    }
  }, [computeNode, t]);

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

  // Shared between the compact + detailed pickers — the detailed one layers on a
  // few extra props (system toggle, trigger copy) below.
  const commonDialogProps = {
    open: open && !showCreate,
    onOpenChange,
    projects: mergedProjects,
    isLoadingProjects: isLoadingScanProjects,
    currentProjectPath,
    openingProjectId,
    isSubmitting,
    computeNodeAvailable: !!computeNode,
    error,
    onProjectClick: (p: ProjectListItem) => void handleProjectClick(p),
    onOpenFolder: () => void handleOpenFolder(),
    onCreateNew: () => setShowCreate(true),
  };

  return (
    <>
      {useCompact ? (
        <CompactProjectSelectDialog {...commonDialogProps} />
      ) : (
        <ProjectSelectDialog
          {...commonDialogProps}
          showSystem={showSystem}
          onShowSystemChange={handleShowSystemChange}
          devMode={devMode}
          trigger={resolvedTrigger}
          remoteProjectName={remoteProjectName}
        />
      )}
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
