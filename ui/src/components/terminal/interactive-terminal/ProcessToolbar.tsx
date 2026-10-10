/**
 * ProcessToolbar — the top bar of a running AgenticProcess, the same on every
 * surface: [debug] — title — [surface switch] | [Fork] [session actions].
 *
 * Every session action other than Fork lives in the session actions menu
 * (`SessionActionsMenu`). The debug menu (`DebugMenu` — CLI flags, gutters,
 * raw-stream viewers) is a terminal thing and shows on the terminal surface
 * only.
 *
 * Restart awareness is backend-driven: any worker-relevant change flips
 * `process.restart_required` and the session actions button glows.
 */

import { AgenticProcess, dataManager, Shell } from '@sdk';
import { hasWorkerStarted, isProcessRunning, WorkerStatus } from '@sdk/process/agentic-types.js';
import { InteractiveTabHeader } from './InteractiveTabHeader';
import { CompactIconAction } from '@src/components/entity-actions/CompactIconAction';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { GitFork, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useSessionSurface } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DebugMenu } from './DebugMenu';
import { SessionActionsMenu } from './SessionActionsMenu';
import { SessionSurfaceSwitch } from './SessionSurfaceSwitch';
import type { ColVisibility, TraceFilters } from './InteractiveTerminal';
import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';

interface ProcessToolbarProps {
  process: AgenticProcess;
  traceFilters: TraceFilters;
  onTraceFiltersChange: (f: TraceFilters) => void;
  colVis: ColVisibility;
  onColVisChange: (v: ColVisibility) => void;
  sessionStartTime?: string | null;
  lastMessageTime?: string | null;
  /** Embedded mode: hide nav-out actions (Open Terminal, Fork, …). */
  embedded?: boolean;
  /** Called when the close button is clicked (only shown when embedded=true). */
  onClose?: () => void;
  /** Shell entity for the PTY viewers and prompt injection. */
  shell?: Shell | null;
}

export function ProcessToolbar({
  process,
  traceFilters,
  onTraceFiltersChange,
  colVis,
  onColVisChange,
  sessionStartTime,
  lastMessageTime,
  embedded,
  onClose,
  shell,
}: ProcessToolbarProps) {
  const { t } = useLingui();
  const handleInjectPrompt = useCallback((text: string) => void shell?.sendInput(text + '\r'), [shell]);
  const { navigation } = useDockNavigation();
  // An embedded terminal is always an xterm, whatever the app's mode says.
  const onTerminalSurface = useSessionSurface() === 'terminal' || !!embedded;

  // Entities mutate in place. Observe names as well as runtime state so a
  // title arriving after the turn settles still repaints the header.
  // initialFetch=false avoids fetching again while subscribing.
  const snapshot = () => JSON.stringify([process.name, process.restart_required, process.status, process.workerStatus]);
  useSyncExternalStore(
    useCallback((cb) => dataManager.subscribe(process.typeId, cb, false), [process]),
    snapshot,
    snapshot,
  );

  const hasSession = !!process.session_id;
  const workerStatus = process.workerStatus;
  // started: process is live RIGHT NOW
  const started = isProcessRunning(process.status);
  // hasTranscript: at least one real assistant turn happened (gates Fork, Open Transcript)
  const hasTranscript = hasSession && hasWorkerStarted(workerStatus) && workerStatus !== WorkerStatus.IDLE;

  const [isForking, setIsForking] = useState(false);

  // Console-only warning on API_TIMEOUT; the effect re-runs on status
  // transitions, so this fires once per stall.
  useEffect(() => {
    if (process.workerStatus === WorkerStatus.API_TIMEOUT) {
      console.warn(
        `[ProcessToolbar] SubAgent ${String(process.typeId)} is taking a long time to respond — the Anthropic API may be slow or unresponsive.`,
      );
    }
  }, [process.workerStatus, process.typeId]);

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

  const processDisplayName = useMemo(() => resolveProcessDisplayName(process), [process.name]);

  const debugSlot = onTerminalSurface && (
    <DebugMenu
      process={process}
      traceFilters={traceFilters}
      onTraceFiltersChange={onTraceFiltersChange}
      colVis={colVis}
      onColVisChange={onColVisChange}
      shell={shell}
    />
  );

  // Entity name — absolutely centered in the header (truncated for header fit;
  // full name lives in the tab tooltip). Stays put across surfaces.
  const titleSlot = !embedded && (
    <span
      className="max-w-[240px] truncate text-xs font-medium text-foreground"
      title={processDisplayName}
      data-testid="process-header-name"
    >
      {processDisplayName}
    </span>
  );

  // Switch this session to the two OTHER surfaces (Terminal ⇄ Chat ⇄ Vibe).
  const surfaceSwitchSlot = embedded ? null : <SessionSurfaceSwitch process={process} />;

  const rightSlot = (
    <>
      {/* Fork — a chat session forks too; hidden in embedded mode. */}
      {!embedded && (
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
      )}

      <SessionActionsMenu
        process={process}
        hasTranscript={hasTranscript}
        sessionStartTime={sessionStartTime}
        lastMessageTime={lastMessageTime}
        embedded={embedded}
        onInjectPrompt={handleInjectPrompt}
      />

      {/* Close — only in embedded mode */}
      {embedded && onClose && (
        <CompactIconAction icon={X} testId="process-toolbar-close" label={t`Close terminal`} onClick={onClose} />
      )}
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <InteractiveTabHeader debug={debugSlot} title={titleSlot} right={rightSlot} modes={surfaceSwitchSlot} />
    </TooltipProvider>
  );
}
