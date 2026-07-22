import { Trans, useLingui } from '@lingui/react/macro';
import { GitStatusProvider } from '@src/components/status-bar/GitStatusContext';
import { GitPushButton } from '@src/components/status-bar/GitPushButton';
import { GitStatusPill } from '@src/components/status-bar/GitStatusPill';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { WikiTip } from '@src/components/wiki-tip';
import { useProjects } from '@src/hooks/use-projects';
import { useContext } from '@src/hooks/useContext';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { topicTag } from '@src/topics/topic-tag';
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
  const { t } = useLingui();
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
  const openFolderLabel = t`Open folder: ${projectPath}`;

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
        <div className={`flex min-w-0 items-center gap-2 ${className}`}>
          <button
            type="button"
            onClick={openProjectModal}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-red-500/50 bg-red-500/10 px-2.5 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/20 dark:text-red-300"
            title={t`No project selected — pick one to enable project-scoped actions`}
          >
            <ArrowLeftRight className="h-3 w-3 shrink-0" />
            <Trans>Select Project</Trans>
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

  const rootTooltip = t`Current project is on root folder, this is not recommended`;
  const glowStyle: React.CSSProperties = isRoot
    ? { animation: 'root-glow 2s ease-in-out infinite' }
    : {};

  return (
    <>
      {isRoot && <style>{ROOT_GLOW_STYLE}</style>}
      <div className={`flex min-w-0 items-center gap-2 ${className}`}>
        <button
          onClick={openProjectModal}
          className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] transition-colors hover:bg-accent hover:text-foreground"
          style={isRoot ? { ...glowStyle, color: undefined } : { color: 'var(--muted-foreground)' }}
          title={isRoot ? rootTooltip : t`Switch project`}
        >
          <ArrowLeftRight className="h-3 w-3 shrink-0" />
          <span className="hidden sm:inline" style={glowStyle}><Trans>Switch Project</Trans></span>
        </button>
        {/* One-line tip: the project path plus a W-square button that opens the
            "Flowpad project" wiki page in a modal (like the skill preview). */}
        <WikiTip
          wikiword="Flowpad project"
          label={isRoot ? rootTooltip : projectPath ?? t`Open project view`}
          buttonLabel={t`What is a Flowpad project?`}
        >
          <button
            {...topicTag('ProjectPage', 'button')}
            onClick={() => navigation.openDock(DockPointer.forProject(project.id))}
            // Flexible, truncating slot: it is the ONE element in the footer
            // allowed to shrink. min-w-0 defeats the flex min-content floor so
            // the name ellipsizes (instead of overrunning the bar) under width
            // pressure; max-w keeps one long name from starving the counters.
            // Full name stays reachable via title + aria-label.
            className="block min-w-0 max-w-[34ch] shrink truncate text-left text-xs font-medium transition-colors hover:underline"
            style={isRoot ? glowStyle : { color: 'var(--muted-foreground)' }}
            title={project.displayName}
            aria-label={isRoot ? rootTooltip : projectPath ? t`Open project view — ${projectPath}` : t`Open project view`}
          >
            {project.displayName}
          </button>
        </WikiTip>
        {projectPath && computeNode && (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                onClick={() => void handleOpenFolder()}
                className="flex items-center text-[10px] text-muted-foreground/70 transition-colors hover:text-primary"
                aria-label={openFolderLabel}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{openFolderLabel}</TooltipContent>
          </Tooltip>
        )}
        <GitStatusProvider computeNodeId={computeNode?.id ?? null} workdir={projectPath}>
          <GitStatusPill />
          <GitPushButton />
        </GitStatusProvider>
      </div>
      <OpenProjectComponent
        open={isProjectModalOpen}
        onOpenChange={setIsProjectModalOpen}
        onProjectChanged={() => void refetchProjects()}
      />
    </>
  );
}
