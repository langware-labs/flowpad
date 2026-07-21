import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';
import { QuickCreatePanel, useQuickCreatePick } from '@src/components/quick-create/QuickCreatePanel';
import { SecretsCard } from './SecretsCard';
import { HomeCustomizationCard } from './HomeCustomizationCard';
import { VibeAgentsCard } from './VibeAgentsCard';
import { Button } from '@src/components/ui/button';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { WorkerToolbar } from '@src/components/workers/WorkerToolbar';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import { Project, TypeId } from '@sdk';
import { History, Loader2, SquareTerminal } from 'lucide-react';
import React, { useMemo } from 'react';
import { Trans } from '@lingui/react/macro';

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
 * top-to-bottom: the project-level Members roster, the session launchers, and —
 * as the body — the create-new surface (`QuickCreatePanel`) spread out plainly
 * rather than hidden behind the desktop "+" tile's modal. The terminal empty
 * state also shows the spawn openers via `showSessionStarters`.
 */
export const ProjectHome: React.FC<ProjectHomeProps> = ({ spawnProjectId, showSessionStarters = false }) => {
  const dataCtx = useDataContext();

  // Resolve the target project (explicit spawn pin, else the active project).
  const projectId = spawnProjectId ?? dataCtx.project?.id ?? null;
  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );

  // The dialogs the create tiles defer to. Hosted here rather than in the panel
  // so they outlive whatever the tile click dismisses.
  const { panelProps, dialogs } = useQuickCreatePick();

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
          <MembersAvatarStack typeId={projectTypeId} allowInviteLink />
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
        <div className="mx-auto flex w-full flex-col gap-6 px-4 py-6">
          {showSessionStarters && <SessionStarters spawnProjectId={spawnProjectId} />}

          <QuickCreatePanel {...panelProps} />

          {/* Project secrets — value-free references + setup wizard. */}
          {dataCtx.project?.id === projectId && dataCtx.project && (
            <SecretsCard project={dataCtx.project as unknown as Project} />
          )}

          {/* Home customization — title + background written to .flow/customization/. */}
          {dataCtx.project?.id === projectId && dataCtx.project && (
            <HomeCustomizationCard project={dataCtx.project as unknown as Project} />
          )}

          {/* Vibe agents — kind==vibe agents layered onto the standard vibe agent. */}
          {dataCtx.project?.id === projectId && dataCtx.project && (
            <VibeAgentsCard project={dataCtx.project as unknown as Project} />
          )}
        </div>
      </div>
      {dialogs}
    </div>
  );
};
