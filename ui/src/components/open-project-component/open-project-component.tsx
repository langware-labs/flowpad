import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useClaudeProjectList, getProjectDisplayName } from '@src/hooks/use-claude-projects';
import {
  ContextEntitiesEnum,
  dataContext,
  type ProjectListItem,
  Project,
  QueryRequest,
} from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { useToast } from '@src/hooks/use-toast';
import { Check, FolderOpen, FolderPlus, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const normalizePath = (path: string): string => {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
};

const canonicalPathKey = (path: string): string => normalizePath(path).replace(/^\/+/, '');

const getProjectPath = (project: Project): string => normalizePath(project.fs_storage_mount_path || project.name || '');

interface OpenProjectComponentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectChanged?: () => void;
}

export function OpenProjectComponent({ open, onOpenChange, onProjectChanged }: OpenProjectComponentProps) {
  const { project: currentProject } = useProject();
  const { toast } = useToast();
  const { projects: scanProjects, isLoading: isLoadingScanProjects } = useClaudeProjectList({ enabled: open });
  const { computeNode } = useAgentContext();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [parentFolderPath, setParentFolderPath] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);

  // Reset state when dialog opens
  useEffect(() => {
    if (!open) return;
    setShowCreateForm(false);
    setNewProjectName('');
    setParentFolderPath(defaultWorkspacePath);
    setError(null);
    setIsSubmitting(false);
    setOpeningProjectId(null);
  }, [open, defaultWorkspacePath]);

  const currentProjectPath = useMemo(
    () => normalizePath(currentProject?.fs_storage_mount_path || currentProject?.name || ''),
    [currentProject],
  );

  const setCurrentProjectContext = useCallback(
    async (project: Project) => {
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
      await dataContext.refreshProject();
      onProjectChanged?.();
    },
    [onProjectChanged],
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

  // Click a project from the list
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

  // Pick a folder via the backend compute node dialog.
  // The dialog must open as part of the app (not a separate dock icon).
  const pickFolder = useCallback(async (): Promise<string | null> => {
    if (!computeNode) {
      setError('No compute node available');
      return null;
    }
    try {
      return await computeNode.openPathDialog();
    } catch (err) {
      setError('Failed to open folder picker');
      return null;
    }
  }, [computeNode]);

  // Open folder via picker
  const handleOpenFolder = useCallback(async () => {
    const selected = await pickFolder();
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

  // Browse for parent folder in create mode
  const handleBrowseParent = useCallback(async () => {
    const selected = await pickFolder();
    if (selected) {
      setParentFolderPath(selected);
      setError(null);
    }
  }, [pickFolder]);

  // Create new project
  const handleCreate = useCallback(async () => {
    if (!newProjectName.trim() || !parentFolderPath.trim()) {
      setError('Please fill in both fields');
      return;
    }

    const fullPath = `${normalizePath(parentFolderPath)}/${newProjectName.trim()}`;
    setIsSubmitting(true);
    setError(null);
    try {
      await ensureProjectAndSetContext(fullPath);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setIsSubmitting(false);
    }
  }, [newProjectName, parentFolderPath, ensureProjectAndSetContext, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Projects</DialogTitle>
          <DialogDescription>Select a project or open a new folder.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto pr-1">
          {/* Project list */}
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-card">
            {isLoadingScanProjects ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading projects...
              </div>
            ) : scanProjects.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No projects found</div>
            ) : (
              <div className="divide-y divide-border">
                {scanProjects.map((project) => {
                  const projectPath = normalizePath(project.cwd || project.name || '');
                  const isCurrent = !!currentProjectPath && canonicalPathKey(projectPath) === canonicalPathKey(currentProjectPath);
                  const isOpening = openingProjectId === project.id;

                  return (
                    <button
                      key={project.id}
                      onClick={() => void handleProjectClick(project)}
                      disabled={!!openingProjectId || isSubmitting}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50 disabled:opacity-50 ${isCurrent ? 'bg-accent/30' : ''}`}
                    >
                      {isOpening ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : isCurrent ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      ) : (
                        <div className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{getProjectDisplayName(project)}</div>
                        {project.cwd && (
                          <div className="truncate font-mono text-xs text-muted-foreground">{project.cwd}</div>
                        )}
                      </div>
                      {project.session_count > 0 && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {project.session_count} session{project.session_count !== 1 ? 's' : ''}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={() => void handleOpenFolder()}
              disabled={!computeNode || isSubmitting || !!openingProjectId}
            >
              <FolderOpen className="h-4 w-4" />
              Open Folder
            </Button>
            <Button
              variant={showCreateForm ? 'default' : 'outline'}
              className="flex-1 gap-2"
              onClick={() => setShowCreateForm(!showCreateForm)}
              disabled={isSubmitting || !!openingProjectId}
            >
              <FolderPlus className="h-4 w-4" />
              Create New
            </Button>
          </div>

          {/* Inline create form */}
          {showCreateForm && (
            <div className="space-y-3 rounded-lg border bg-card p-3">
              <div className="space-y-2">
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  placeholder="my-awesome-project"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="parent-folder">Parent folder</Label>
                <div className="flex gap-2">
                  <Input
                    id="parent-folder"
                    value={parentFolderPath}
                    onChange={(e) => setParentFolderPath(e.target.value)}
                    placeholder={defaultWorkspacePath || 'Select parent folder'}
                    className="flex-1 font-mono text-sm"
                    dir="ltr"
                  />
                  {computeNode && (
                    <Button variant="outline" onClick={() => void handleBrowseParent()} type="button" title="Browse">
                      <FolderOpen className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
              <Button
                className="w-full"
                onClick={() => void handleCreate()}
                disabled={isSubmitting || !newProjectName.trim() || !parentFolderPath.trim()}
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
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default OpenProjectComponent;
