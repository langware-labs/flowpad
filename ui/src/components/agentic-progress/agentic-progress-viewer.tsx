import { useState } from 'react';
import { AgenticProcess, ProcessorStatus, TypeId } from '@sdk';
import { useEntityData } from '@sdk/react/hooks';
import { cn } from '@src/lib/utils';
import { useAgenticProcessState } from './hooks/use-agentic-process-state';
import { CompactProgressBar } from './compact-progress-bar';
import { FullProgressModal } from './full-progress-modal';

interface AgenticProgressViewerProps {
  /**
   * The AgenticProcess to display.
   * Can be null when process hasn't started yet.
   */
  process?: AgenticProcess | null;

  /**
   * Path to the instruction file being executed.
   * Used for display purposes.
   */
  filePath?: string;

  /**
   * Callback when user submits input (for blocking UI).
   * Called when process is waiting for input.
   */
  onInputSubmit?: (data: unknown) => void;

  /**
   * Callback to abort execution.
   */
  onAbort?: () => void;

  /**
   * Additional CSS classes.
   */
  className?: string;

  /**
   * Start with modal open.
   */
  defaultExpanded?: boolean;
}

/**
 * Main wrapper component for displaying AgenticProcess execution progress.
 *
 * Renders a compact single-line progress bar by default.
 * Click "Expand" to open a full modal with detailed stack trace and variables.
 *
 * Uses:
 * - useAgenticProcessState: For ProcessorState updates (status, stack, variables)
 * - useEntityData: For FlowData output stream (chat messages, results)
 *
 * @example
 * ```tsx
 * const process = await processor.run(instructionFile, context);
 *
 * <AgenticProgressViewer
 *   process={process}
 *   filePath={instructionFile.path}
 *   onAbort={() => processor.abort()}
 * />
 * ```
 */
export function AgenticProgressViewer({
  process,
  filePath,
  onInputSubmit: _onInputSubmit,
  onAbort: _onAbort,
  className,
  defaultExpanded = false,
}: AgenticProgressViewerProps) {
  const [isModalOpen, setIsModalOpen] = useState(defaultExpanded);

  // Get TypeId from process for useEntityData hook
  const processTypeId = process ? new TypeId('agentic_process', process.id) : null;

  // Subscribe to FlowData outputs via useEntityData hook
  const { flowData, isComplete: flowDataComplete, count: flowDataCount } = useEntityData(processTypeId);

  // Subscribe to process state changes
  const { state, completed, error: _error } = useAgenticProcessState(process);

  // Default state when no process
  const displayState = state || {
    status: ProcessorStatus.IDLE,
    index: 0,
    totalInstructions: 0,
    variables: {},
    waitingForInput: false,
    inputId: null,
    stack: [],
    debug: { enabled: false, breakpoints: [], stepMode: null },
    error: null,
    mdoContent: null,
  };

  return (
    <div className={cn('w-full', className)} data-testid="agentic-progress-viewer">
      {/* Compact Progress Bar */}
      <CompactProgressBar
        state={displayState}
        filePath={filePath}
        onExpand={() => setIsModalOpen(true)}
        flowDataCount={flowDataCount}
      />

      {/* Full Progress Modal */}
      <FullProgressModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        state={displayState}
        filePath={filePath}
        flowData={flowData}
        flowDataCount={flowDataCount}
      />

      {/* Hidden test elements */}
      <div data-testid="flow-data-count" className="hidden">
        {flowDataCount}
      </div>
      <div data-testid="flow-data-complete" className="hidden">
        {flowDataComplete ? 'true' : 'false'}
      </div>
      <div data-testid="process-status" className="hidden">
        {displayState.status}
      </div>
      <div data-testid="process-completed" className="hidden">
        {completed ? 'true' : 'false'}
      </div>
    </div>
  );
}

/**
 * Standalone compact progress bar (without modal functionality).
 * Use when you only need the compact view.
 */
export { CompactProgressBar } from './compact-progress-bar';

/**
 * Standalone full progress modal.
 * Use when you want to control the modal externally.
 */
export { FullProgressModal } from './full-progress-modal';
