/**
 * ProcessToolbar — the top bar of a running AgenticProcess, the same on every
 * surface: [debug] [restart] — title — [chips] [Fork] | [surface switch] [session actions].
 *
 * Every session action other than Fork lives in the session actions menu
 * (`SessionActionsMenu`); the terminal surface also shows Restart as a button. The debug menu (`DebugMenu` — CLI flags, gutters,
 * raw-stream viewers) is a terminal thing and shows on the terminal surface
 * only, and so is the Restart button beside it.
 *
 * Restart awareness is backend-driven: any worker-relevant change flips
 * `process.restart_required`. On the terminal surface the Restart button
 * glows; elsewhere the session actions button does, since restart lives in
 * its menu there.
 */

import { AgenticProcess, dataManager, Shell } from '@sdk';
import { WorkerStatus } from '@sdk/process/agentic-types.js';
import { InteractiveTabHeader } from './InteractiveTabHeader';
import { CompactIconAction } from '@src/components/entity-actions/CompactIconAction';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useSessionSurface } from '@src/contexts/view-mode-context';
import { DebugMenu } from './DebugMenu';
import { ProcessSourceChips } from './ProcessSourceChips';
import { RestartButton } from './RestartButton';
import { SessionAnchor } from './SessionAnchor';
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

  // Console-only warning on API_TIMEOUT; the effect re-runs on status
  // transitions, so this fires once per stall.
  useEffect(() => {
    if (process.workerStatus === WorkerStatus.API_TIMEOUT) {
      console.warn(
        `[ProcessToolbar] SubAgent ${String(process.typeId)} is taking a long time to respond — the Anthropic API may be slow or unresponsive.`,
      );
    }
  }, [process.workerStatus, process.typeId]);

  const processDisplayName = useMemo(() => resolveProcessDisplayName(process), [process.name]);

  const debugSlot = onTerminalSurface && (
    <>
      <DebugMenu
        process={process}
        traceFilters={traceFilters}
        onTraceFiltersChange={onTraceFiltersChange}
        colVis={colVis}
        onColVisChange={onColVisChange}
        shell={shell}
      />
      <RestartButton process={process} />
    </>
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

  // Optional bits (source chips, Close) sit left of the anchor so they never move it.
  const rightSlot = (
    <>
      {!embedded && <ProcessSourceChips process={process} />}
      {embedded && onClose && (
        <CompactIconAction icon={X} testId="process-toolbar-close" label={t`Close terminal`} onClick={onClose} />
      )}
      <SessionAnchor
        process={process}
        embedded={embedded}
        sessionStartTime={sessionStartTime}
        lastMessageTime={lastMessageTime}
        onInjectPrompt={handleInjectPrompt}
        glowOnRestart={!onTerminalSurface}
      />
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <InteractiveTabHeader debug={debugSlot} title={titleSlot} right={rightSlot} />
    </TooltipProvider>
  );
}
