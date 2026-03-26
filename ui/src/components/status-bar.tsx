import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { useProjects } from '@src/hooks/use-projects';
import { useContext } from '@src/hooks/useContext';
import { fsManager } from '@sdk';
import { ExternalLink, ArrowLeftRight } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface StatusBarProps {
  className?: string;
}

export function StatusBar({ className = '' }: StatusBarProps) {
  const { project, computeNode, bootstrapInfo } = useContext();
  const workspacePath = bootstrapInfo?.desktop_info?.paths?.workspace;
  const { refetch: refetchProjects } = useProjects();
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);

  // Get the project's working directory path
  const projectPath = useMemo(() => {
    if (!project) return null;
    let path = project.fs_storage_mount_path;
    if (!path && workspacePath && project.displayName) {
      path = `${workspacePath}/${project.displayName}`;
    }
    if (!path) {
      path = project.name || project.displayName || '';
    }
    return path;
  }, [project, workspacePath]);

  const handleOpenFolder = useCallback(async () => {
    if (!computeNode?.typeId || !projectPath) return;
    try {
      const relativePath = projectPath.replace(/^\//, '');
      await fsManager.open(computeNode.typeId, relativePath);
    } catch (error) {
      console.error('[StatusBar] Failed to open folder:', error);
    }
  }, [computeNode?.typeId, projectPath]);

  const openProjectModal = useCallback(() => {
    setIsProjectModalOpen(true);
  }, []);

  if (!project) return null;

  return (
    <>
      <div className={`flex items-center gap-2 ${className}`}>
        <button
          onClick={openProjectModal}
          className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Switch project"
        >
          <ArrowLeftRight className="h-3 w-3 shrink-0" />
          <span>Switch Project</span>
        </button>
        <button
          onClick={openProjectModal}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary hover:underline"
          title="Switch project"
        >
          {project.displayName}
        </button>
        {projectPath && computeNode && (
          <button
            onClick={() => void handleOpenFolder()}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-primary"
            title="Open folder"
          >
            <span className="max-w-[400px] truncate">{projectPath}</span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </button>
        )}
      </div>
      <OpenProjectComponent
        open={isProjectModalOpen}
        onOpenChange={setIsProjectModalOpen}
        onProjectChanged={() => void refetchProjects()}
      />
    </>
  );
}
