/**
 * SessionAnchor — the session's fixed top-right group: [Fork] | [surface switch] [session actions].
 *
 * Every surface (Terminal, Chat, Vibe) renders this same group as the LAST thing
 * in its top row, so switching surfaces leaves the switch and the menu in place.
 * Anything optional (source chips, Close) goes left of it, never between.
 */

import { AgenticProcess, dataManager, tabManager } from '@sdk';
import { hasWorkerStarted, isProcessRunning, WorkerStatus } from '@sdk/process/agentic-types.js';
import { CompactIconAction } from '@src/components/entity-actions/CompactIconAction';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { GitFork, X } from 'lucide-react';
import { memo, useCallback, useState, useSyncExternalStore } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useVibeOnlyAgent } from '@src/hooks/use-launching-agent';
import { SessionActionsMenu } from './SessionActionsMenu';
import { SessionSurfaceSwitch } from './SessionSurfaceSwitch';
import { DockPointer } from '@src/navigation/DockPointer';
import { closeTabsWithLifecycle } from '@src/tabs/tab-content-lifecycle';

interface SessionAnchorProps {
  process: AgenticProcess;
  /** Embedded mode: no Fork, no surface switch, menu without nav-out actions. */
  embedded?: boolean;
  sessionStartTime?: string | null;
  lastMessageTime?: string | null;
  /** Sends a prompt to the session (Commit & merge). Defaults to the session's own queue. */
  onInjectPrompt?: (text: string) => void;
  /** Glow the menu on restart_required (off when a Restart button carries it). */
  glowOnRestart?: boolean;
}

export const SessionAnchor = memo(function SessionAnchor({
  process,
  embedded,
  sessionStartTime,
  lastMessageTime,
  onInjectPrompt,
  glowOnRestart = true,
}: SessionAnchorProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  // A vibe-only agent's session stays in Vibe: its only chrome is Close.
  const vibeOnlyAgent = useVibeOnlyAgent(process.id);
  const injectPrompt = useCallback(
    (text: string) => (onInjectPrompt ? onInjectPrompt(text) : void process.promptOrEnqueue(text)),
    [onInjectPrompt, process],
  );

  // Fork's gate follows the worker's state; repaint when it changes.
  const snapshot = () => JSON.stringify([process.session_id, process.status, process.workerStatus]);
  useSyncExternalStore(
    useCallback((cb) => dataManager.subscribe(process.typeId, cb, false), [process]),
    snapshot,
    snapshot,
  );

  const hasSession = !!process.session_id;
  const workerStatus = process.workerStatus;
  const started = isProcessRunning(process.status);
  // At least one real assistant turn happened (gates Fork and Open transcript).
  const hasTranscript = hasSession && hasWorkerStarted(workerStatus) && workerStatus !== WorkerStatus.IDLE;

  const [isForking, setIsForking] = useState(false);
  const handleFork = async () => {
    if (isForking) return;
    setIsForking(true);
    try {
      const newProcess = await process.fork(true);
      void navigation.openShellProcess(newProcess.id);
    } finally {
      setIsForking(false);
    }
  };

  // A vibe-only session has no tab strip, so no tab X: Close closes its own tab
  // and the tabs it hosts, then lands where the top bar's Home button lands.
  const closeVibeOnly = () => {
    const sessionPointer = DockPointer.forSession(process.id).pointer;
    const tabs = tabManager.getSnapshot().filter((tab) => {
      if (!tab.dockPointer) return false;
      const dock = new DockPointer(tab.dockPointer);
      return dock.hostProcessId === process.id || dock.pointer === sessionPointer;
    });
    navigation.goHome();
    void closeTabsWithLifecycle(tabs).finally(() => void tabManager.refresh());
  };

  if (vibeOnlyAgent) {
    if (embedded) return null;
    return (
      <button
        type="button"
        onClick={closeVibeOnly}
        title={t`Close`}
        aria-label={t`Close`}
        data-testid="vibe-only-close"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
      >
        <X className="h-5 w-5" strokeWidth={2.5} />
      </button>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex shrink-0 items-center gap-0.5" data-testid="session-anchor">
        {!embedded && (
          <>
            <CompactIconAction
              icon={GitFork}
              testId="process-toolbar-fork"
              label={
                isForking
                  ? t`Forking…`
                  : hasTranscript
                    ? t`Fork session — new tab, same conversation history`
                    : !hasSession
                      ? t`Launch a session first`
                      : !started
                        ? t`Session is not running`
                        : t`Send a message first — fork requires conversation history`
              }
              disabled={!hasTranscript || isForking}
              onClick={() => void handleFork()}
            />
            {/* The surface selector, divided from Fork on its left; the menu sits right after it. */}
            <div className="ms-1.5 flex items-center border-s border-border ps-1.5">
              <SessionSurfaceSwitch process={process} />
            </div>
          </>
        )}
        <SessionActionsMenu
          process={process}
          hasTranscript={hasTranscript}
          sessionStartTime={sessionStartTime}
          lastMessageTime={lastMessageTime}
          embedded={embedded}
          onInjectPrompt={injectPrompt}
          glowOnRestart={glowOnRestart}
        />
      </div>
    </TooltipProvider>
  );
});
