import { ComputeNode, fsManager, Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { Check, ExternalLink, Folder, FolderOpen, FolderPlus, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ConfirmDialog } from '../ui/confirm-dialog';
import './ProjectSidebar.css';

export interface ProjectSidebarProps {
  projects: Project[] | undefined;
  isLoading: boolean;
  onProjectClick?: (project: Project) => void;
  onNewProject?: () => void;
  onOpenProject?: () => void;
  onProjectDeleted?: () => void;
  currentProjectId?: string;
  title?: string;
  /** Compute node for VFS operations */
  computeNode?: ComputeNode | null;
  /** Workspace path for constructing full project paths */
  workspacePath?: string;
}

export function ProjectSidebar({
  projects,
  isLoading,
  onProjectClick,
  onNewProject,
  onOpenProject,
  onProjectDeleted,
  currentProjectId,
  title = 'Projects',
  computeNode,
  workspacePath,
}: ProjectSidebarProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleOpenInExplorer = useCallback(
    async (e: React.MouseEvent, project: Project) => {
      e.stopPropagation();
      if (!computeNode?.typeId) {
        console.warn('[ProjectSidebar] No compute node available for VFS operations');
        return;
      }
      try {
        // Open the project's folder in the system file explorer
        // Use computeNode.typeId as the VFS reference
        // Priority: fs_storage_mount_path > workspace + displayName > name
        let projectPath = project.fs_storage_mount_path;
        if (!projectPath && workspacePath && project.displayName) {
          // Construct path from workspace + project folder name
          projectPath = `${workspacePath}/${project.displayName}`;
        }
        if (!projectPath) {
          projectPath = project.name || '';
        }
        // Remove leading / for VFS relative path
        const relativePath = projectPath.replace(/^\//, '');
        await fsManager.open(computeNode.typeId, relativePath);
      } catch (error) {
        console.error('[ProjectSidebar] Failed to open in explorer:', error);
      }
    },
    [computeNode?.typeId, workspacePath],
  );

  const handleDeleteClick = useCallback((e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    setProjectToDelete(project);
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!projectToDelete) return;

    setIsDeleting(true);
    try {
      await projectToDelete.delete();
      onProjectDeleted?.();
    } catch (error) {
      console.error('[ProjectSidebar] Failed to delete project:', error);
    } finally {
      setIsDeleting(false);
      setProjectToDelete(null);
    }
  }, [projectToDelete, onProjectDeleted]);

  // Compute project paths for tooltips
  const getProjectPath = useCallback(
    (project: Project): string => {
      let projectPath = project.fs_storage_mount_path;
      if (!projectPath && workspacePath && project.displayName) {
        projectPath = `${workspacePath}/${project.displayName}`;
      }
      if (!projectPath) {
        projectPath = project.name || project.displayName || '';
      }
      return projectPath;
    },
    [workspacePath],
  );

  return (
    <div className="project-sidebar">
      <div className="project-sidebar-header">
        <h3>{title}</h3>
      </div>

      {/* Action buttons */}
      <div className="project-sidebar-actions">
        <Button variant="ghost" size="sm" className="project-action-btn" onClick={onOpenProject}>
          <FolderOpen className="h-4 w-4" />
          Open Project
        </Button>
        <Button variant="ghost" size="sm" className="project-action-btn" onClick={onNewProject}>
          <FolderPlus className="h-4 w-4" />
          New Project
        </Button>
      </div>

      <div className="project-sidebar-content">
        {isLoading ? (
          <div className="project-sidebar-loading">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading...</span>
          </div>
        ) : !projects || projects.length === 0 ? (
          <div className="project-sidebar-empty">
            <Folder className="h-8 w-8 opacity-30" />
            <span>No projects yet</span>
          </div>
        ) : (
          <ul className="project-sidebar-list">
            <TooltipProvider delayDuration={300}>
              {projects.map((project) => {
                const isActive = currentProjectId === project.id;
                const projectPath = getProjectPath(project);
                return (
                  <li key={project.id} className="project-sidebar-list-item">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className={cn('project-sidebar-item', isActive && 'active')}
                          onClick={() => onProjectClick?.(project)}
                        >
                          <Folder className="project-icon" />
                          <span className="project-name">{project.displayName}</span>
                          {isActive && <Check className="project-check" />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs break-all text-xs">
                        {projectPath}
                      </TooltipContent>
                    </Tooltip>
                    <div className="project-item-actions">
                      <button
                        className="project-item-action"
                        onClick={(e) => void handleOpenInExplorer(e, project)}
                        title="Open in Explorer"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="project-item-action project-item-action-delete"
                        onClick={(e) => handleDeleteClick(e, project)}
                        title="Delete Project"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </TooltipProvider>
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Project"
        description={`Are you sure you want to delete "${projectToDelete?.displayName}"? This action cannot be undone.`}
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete'}
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}

export default ProjectSidebar;
