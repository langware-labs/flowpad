import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { Button } from '@src/components/ui/button';
import { useTerminalStripController } from '@src/tabs/useTerminalStripController';
import { History, Loader2, SquareTerminal } from 'lucide-react';
import React from 'react';
import { Trans } from '@lingui/react/macro';
import { ContextFolders } from './ContextFolders';

interface ProjectBriefProps {
  /** Pin spawned shells/processes to this project; otherwise the active project. */
  spawnProjectId?: string | null;
}

/**
 * ProjectBrief — the project's landing surface, shown wherever a project has no
 * open content: the terminal body's empty state (no terminal sessions) and the
 * project-home content slot (no asset/item selected). Offers the spawn openers
 * (Claude Code / Terminal / history) and the project's context folders (see
 * `ContextFolders`). Expected to grow more project overview content over time —
 * hence "brief" rather than "empty state".
 */
export const ProjectBrief: React.FC<ProjectBriefProps> = ({ spawnProjectId }) => {
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
    <div className="flex h-full flex-col items-center justify-center gap-6 text-muted-foreground">
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
  );
};
