import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';
import { Button } from '@src/components/ui/button';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import { Project, TypeId } from '@sdk';
import { History, Loader2, SquareTerminal } from 'lucide-react';
import React, { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import { ContextFolders } from './ContextFolders';

interface ProjectHomeProps {
  /** Pin spawned shells/processes to this project; otherwise the active project. */
  spawnProjectId?: string | null;
}

/**
 * ProjectHome — the project's landing surface, shown wherever a project has no
 * open content: the terminal body's empty state (no terminal sessions) and the
 * project-home content slot (no asset/item selected). The one surface that is
 * unambiguously "the project itself" rather than content inside it, so it hosts
 * project-level collaboration (the Members bar) alongside the spawn openers
 * (Claude Code / Terminal / history) and the project's context folders
 * (see `ContextFolders`).
 */
export const ProjectHome: React.FC<ProjectHomeProps> = ({ spawnProjectId }) => {
  const dataCtx = useDataContext();
  const {
    modals,
    isTabCreationPending,
    isClaudeCreationPending,
    isTerminalCreationPending,
    handleStartClaude,
    handleStartTerminal,
    handleOpenHistory,
  } = useTerminalStripController({ spawnProjectId });

  // Resolve the target project (explicit spawn pin, else the active project)
  // for the Members roster — same resolution ContextFolders uses.
  const projectId = spawnProjectId ?? dataCtx.project?.id ?? null;
  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Members — project-level roster + invite (role-gated inside the stack). */}
      {projectTypeId && (
        <div
          className="flex items-center justify-between border-b border-border/50 px-4 py-2"
          data-testid="project-home-members"
        >
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Trans>Members</Trans>
          </span>
          <MembersAvatarStack typeId={projectTypeId} />
        </div>
      )}

      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-muted-foreground">
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm"><Trans>No terminal sessions</Trans></p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void handleStartClaude()}
              disabled={isTabCreationPending}
              data-testid="start-claude-button"
            >
              {isClaudeCreationPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ClaudeIcon className="h-4 w-4 text-orange-500" />
              )}
              <Trans>Claude Code</Trans>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void handleStartTerminal()}
              disabled={isTabCreationPending}
            >
              {isTerminalCreationPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SquareTerminal className="h-4 w-4" />
              )}
              <Trans>Terminal</Trans>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleOpenHistory}
              disabled={isTabCreationPending}
              data-testid="open-history-button"
            >
              <History className="h-4 w-4" />
              <Trans>Open from history</Trans>
            </Button>
          </div>
        </div>

        <ContextFolders spawnProjectId={spawnProjectId} />

        {modals}
      </div>
    </div>
  );
};
