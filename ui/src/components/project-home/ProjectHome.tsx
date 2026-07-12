import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';
import { MiniDesktop } from '@src/components/quick-create/MiniDesktop';
import { Button } from '@src/components/ui/button';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { WorkerToolbar } from '@src/components/workers/WorkerToolbar';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import { projectScope } from '@src/lib/scope-filter';
import { Project, TypeId } from '@sdk';
import { History, Loader2, SquareTerminal } from 'lucide-react';
import React, { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import { ContextFolders } from './ContextFolders';
import { Secrets } from './Secrets';

interface ProjectHomeProps {
  /** Pin spawned shells/processes to this project; otherwise the active project. */
  spawnProjectId?: string | null;
  /** Show the "start a session" openers (Claude Code / Terminal / history).
   *  On for the terminal body's empty state (its whole point is to start one);
   *  off for the project-home landing, which is a browse surface. */
  showSessionStarters?: boolean;
}

/**
 * SessionStarters — the spawn openers (Claude Code / Terminal / Open from
 * history) + their modals. Encapsulates `useTerminalStripController` so only
 * one controller instance (this one, or StartSessionWorkers' — they render
 * mutually exclusively) runs per ProjectHome.
 */
const SessionStarters: React.FC<{ spawnProjectId?: string | null }> = ({ spawnProjectId }) => {
  const {
    modals,
    isTabCreationPending,
    isClaudeCreationPending,
    isTerminalCreationPending,
    handleStartClaude,
    handleStartTerminal,
    handleOpenHistory,
  } = useTerminalStripController({ spawnProjectId });

  return (
    <div className="flex flex-col items-center gap-4 py-2 text-muted-foreground">
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
      {modals}
    </div>
  );
};

/**
 * StartSessionWorkers — the per-vendor launch buttons for the "Start new
 * session" row on the project-home landing. Encapsulates
 * `useTerminalStripController` (like SessionStarters) so the controller +
 * its modals only run where the row renders.
 */
const StartSessionWorkers: React.FC<{ spawnProjectId?: string | null }> = ({ spawnProjectId }) => {
  const { modals, isTabCreationPending, startWorker } = useTerminalStripController({ spawnProjectId });

  return (
    <>
      <WorkerToolbar
        onLaunch={startWorker}
        starting={isTabCreationPending}
        mode="all"
        testIdPrefix="project-home-worker"
      />
      {modals}
    </>
  );
};

/**
 * ProjectHome — the project's landing surface, shown wherever a project has no
 * open content: the terminal body's empty state (no terminal sessions) and the
 * project-home content slot (no asset/item selected). The one surface that is
 * unambiguously "the project itself" rather than content inside it, so it hosts,
 * top-to-bottom: the project-level Members roster, the project-scoped favorites
 * mini-desktop (bookmarks stamped with this project), and the project's context
 * folders (see `ContextFolders`). The terminal empty state also shows the spawn
 * openers via `showSessionStarters`.
 */
export const ProjectHome: React.FC<ProjectHomeProps> = ({ spawnProjectId, showSessionStarters = false }) => {
  const dataCtx = useDataContext();

  // Resolve the target project (explicit spawn pin, else the active project) —
  // same resolution ContextFolders uses.
  const projectId = spawnProjectId ?? dataCtx.project?.id ?? null;
  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );

  // The mini-desktop is pinned to this project's scope: it shows only bookmarks
  // stamped with this project, and its expand affordance opens the full desktop
  // pinned to the same scope. Unscoped/personal favorites don't leak in.
  const desktopScope = useMemo(() => (projectId ? projectScope(projectId) : null), [projectId]);

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

      {/* Start new session — worker launch row, right below Members. Hidden on
          the terminal empty state, which shows the full SessionStarters instead
          (avoids two controller instances / duplicate modals). */}
      {projectTypeId && !showSessionStarters && (
        <div
          className="flex items-center justify-between border-b border-border/50 px-4 py-2"
          data-testid="project-home-start-session"
        >
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Trans>Start new session</Trans>
          </span>
          <StartSessionWorkers spawnProjectId={spawnProjectId} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
          {showSessionStarters && <SessionStarters spawnProjectId={spawnProjectId} />}

          {desktopScope && (
            <div className="flex flex-col gap-2" data-testid="project-home-bookmarks">
              <span className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Trans>Bookmarks</Trans>
              </span>
              <MiniDesktop scope={desktopScope} />
            </div>
          )}

          <ContextFolders spawnProjectId={spawnProjectId} />
          <Secrets spawnProjectId={spawnProjectId} />
        </div>
      </div>
    </div>
  );
};
