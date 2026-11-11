import { Trans, useLingui } from '@lingui/react/macro';
import { GitStatusProvider } from '@src/components/status-bar/GitStatusContext';
import { GitPullButton } from '@src/components/status-bar/GitPullButton';
import { GitResolveButton } from '@src/components/status-bar/GitResolveButton';
import { GitPushButton } from '@src/components/status-bar/GitPushButton';
import { GitStatusPill } from '@src/components/status-bar/GitStatusPill';
import { OpenProjectComponent } from '@src/components/open-project-component/open-project-component';
import { useProjects } from '@src/hooks/use-projects';
import { useProjectLocation } from '@src/hooks/use-project-location';
import { ArrowLeftRight, TriangleAlert } from 'lucide-react';
import { useCallback, useState } from 'react';

function isRootPath(path: string | null | undefined): boolean {
  if (!path) return false;
  if (path === '/') return true;
  // Windows: C:\  C:/  C:
  if (/^[a-zA-Z]:[/\\]?$/.test(path)) return true;
  return false;
}

const ROOT_GLOW: React.CSSProperties = { animation: 'root-glow 2s ease-in-out infinite' };

const ROOT_GLOW_STYLE = /* css */ `
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
  const { project, computeNode, gitWorkdir } = useProjectLocation();
  const { refetch: refetchProjects } = useProjects();
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);

  const isRoot = isRootPath(project?.fs_storage_mount_path);

  const openProjectModal = useCallback(() => {
    setIsProjectModalOpen(true);
  }, []);

  // No active project. Render a red "Select Project" pill that pops the
  // OpenProjectComponent (the root-folder warning opens it too). Null project is now
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

  return (
    <>
      <div className={`flex min-w-0 items-center gap-2 ${className}`}>
        {/* The project switcher and the project's page live in the top bar's
            project pill; the footer only warns when the project is a root folder. */}
        {isRoot && (
          <>
            <style>{ROOT_GLOW_STYLE}</style>
            <button
              type="button"
              onClick={openProjectModal}
              className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent"
              style={ROOT_GLOW}
              title={t`Current project is on root folder, this is not recommended`}
            >
              <TriangleAlert className="h-3 w-3 shrink-0" />
              <span className="hidden sm:inline">
                <Trans>Project on root folder</Trans>
              </span>
            </button>
          </>
        )}
        <GitStatusProvider computeNodeId={computeNode?.id ?? null} workdir={gitWorkdir}>
          <GitStatusPill />
          <GitResolveButton />
          <GitPullButton />
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
