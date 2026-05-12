import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { useProjects } from '@src/hooks/use-projects';
import { useContext } from '@src/hooks/useContext';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { fsManager } from '@sdk';
import { ExternalLink, ArrowLeftRight } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

function isRootPath(path: string | null | undefined): boolean {
  if (!path) return false;
  if (path === '/') return true;
  // Windows: C:\  C:/  C:
  if (/^[a-zA-Z]:[/\\]?$/.test(path)) return true;
  return false;
}

const ROOT_GLOW_STYLE = /* css */`
  @keyframes root-glow {
    0%, 100% { color: #fbbf24; text-shadow: 0 0 6px #fbbf24, 0 0 12px #f59e0b; }
    50%       { color: #f97316; text-shadow: 0 0 10px #f97316, 0 0 20px #ef4444; }
  }
`;

interface StatusBarProps {
  className?: string;
}

export function StatusBar({ className = '' }: StatusBarProps) {
  const { project, computeNode, bootstrapInfo, workdir } = useContext();
  const workspacePath = bootstrapInfo?.desktop_info?.paths?.workspace;
  const { refetch: refetchProjects } = useProjects();
  const { navigation } = useDockNavigation();
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);

  // Get the active working directory path — prefer context workdir (reflects active tab),
  // fall back to project path for cases where workdir hasn't been set yet (e.g. bootstrap).
  const projectPath = useMemo(() => {
    if (workdir) return workdir;
    if (!project) return null;
    let path = project.fs_storage_mount_path;
    if (!path && workspacePath && project.displayName) {
      path = `${workspacePath}/${project.displayName}`;
    }
    if (!path) {
      path = project.name || project.displayName || '';
    }
    return path;
  }, [workdir, project, workspacePath]);

  const isRoot = isRootPath(project?.fs_storage_mount_path);

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

  // No active project. Render a red "Select Project" pill that pops the same
  // OpenProjectComponent the Switch Project button uses. Null project is now
  // a real (transient) state — entities like a freshly-opened cross-machine
  // conversation can leave context.project null until the user picks one.
  if (!project) {
    return (
      <>
        <div className={`flex items-center gap-2 ${className}`}>
          <button
            type="button"
            onClick={openProjectModal}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-red-500/50 bg-red-500/10 px-2.5 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/20 dark:text-red-300"
            title="No project selected — pick one to enable project-scoped actions"
          >
            <ArrowLeftRight className="h-3 w-3 shrink-0" />
            Select Project
          </button>
        </div>
        <OpenProjectComponent
          open={isProjectModalOpen}
          onOpenChange={setIsProjectModalOpen}
          onProjectChanged={() => void refetchProjects()}
        />
      </>
    );
  }

  const rootTooltip = 'Current project is on root folder, this is not recommended';
  const glowStyle: React.CSSProperties = isRoot
    ? { animation: 'root-glow 2s ease-in-out infinite' }
    : {};

  return (
    <>
      {isRoot && <style>{ROOT_GLOW_STYLE}</style>}
      <div className={`flex items-center gap-2 ${className}`}>
        <button
          onClick={openProjectModal}
          className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] transition-colors hover:bg-accent hover:text-foreground"
          style={isRoot ? { ...glowStyle, color: undefined } : { color: 'var(--muted-foreground)' }}
          title={isRoot ? rootTooltip : 'Switch project'}
        >
          <ArrowLeftRight className="h-3 w-3 shrink-0" />
          <span style={glowStyle}>Switch Project</span>
        </button>
        <button
          onClick={() => navigation.openDock(DockPointer.forProject(project.id))}
          className="text-xs font-medium transition-colors hover:underline"
          style={isRoot ? glowStyle : { color: 'var(--muted-foreground)' }}
          title={isRoot ? rootTooltip : 'Open project view'}
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
