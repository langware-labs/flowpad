import { getWorkerMode, isReadyForInput, ProcessStatus, type StatusBearingProcess, WorkerMode, WorkerStatus } from '@sdk';
import { cn } from '@src/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Terminal } from 'lucide-react';
import { getStatusColor, getStatusIcon, getStatusLabel } from './status-indicator';

/**
 * Reusable one-liner status line for an AgenticProcess.
 *
 * Renders (left-to-right):
 *   [Icon] [Label]  [secondary]  [elapsed]  [Open-in-Terminal button]
 *
 * - Icon + label come from ``getDisplayStatus`` → the right config
 *   (``workerStatusConfig`` when the worker is running; ``processStatusConfig`` otherwise).
 * - Open-in-Terminal button is only rendered when ``onOpenInTerminal`` is passed.
 *   It is disabled unless ``isReadyForInput(process)`` — i.e. the worker is at
 *   ``IDLE`` / ``COMPLETE`` / ``INTERRUPTED`` and the process is in ``RUNNING``
 *   lifecycle state. Tooltip explains why it's disabled.
 * - For processes already in ``WorkerMode.Interactive`` (``visible=true``) the
 *   terminal tab is already open somewhere; we still allow the click — it just
 *   re-navigates to the existing tab. Icon tint signals the mode.
 */
interface ProcessStatusLineProps {
  process: StatusBearingProcess;
  /** Optional elapsed / time-ago text shown after the label. */
  elapsed?: string;
  /** Optional secondary line (e.g. "Run 3", last user message). */
  secondary?: string;
  /** When provided, an Open-in-Terminal button is rendered. */
  onOpenInTerminal?: () => void;
  size?: 'sm' | 'md';
  className?: string;
  /** Optional test id on the outer container. */
  'data-testid'?: string;
}

const sizeStyles = {
  sm: {
    text: 'text-xs',
    secondary: 'text-[11px]',
    icon: 'h-3 w-3',
    btn: 'h-5 w-5',
    btnIcon: 'h-3 w-3',
    gap: 'gap-1.5',
  },
  md: {
    text: 'text-sm',
    secondary: 'text-xs',
    icon: 'h-4 w-4',
    btn: 'h-6 w-6',
    btnIcon: 'h-3.5 w-3.5',
    gap: 'gap-2',
  },
};

export function ProcessStatusLine({
  process,
  elapsed,
  secondary,
  onOpenInTerminal,
  size = 'md',
  className,
  'data-testid': dataTestId,
}: ProcessStatusLineProps) {
  const Icon = getStatusIcon(process);
  const label = getStatusLabel(process);
  const colorClass = getStatusColor(process);
  const ready = isReadyForInput(process);
  const mode = getWorkerMode(process);
  const styles = sizeStyles[size];

  const status = process.status as ProcessStatus | undefined;
  // Two distinct gates depending on worker mode:
  // - Interactive PTY (visible=true): clickable when the worker is ready for
  //   input — clicking just focuses the existing tab.
  // - Headless (visible=false): clickable ONLY when the worker_status is
  //   explicitly terminal-ready for the current turn (IDLE / COMPLETE /
  //   INTERRUPTED), OR the lifecycle reached STOPPED / FAILED with a real
  //   session to resume. We deliberately do NOT use ``isReadyForInput`` here
  //   because its "no worker_status + no session_id → ready" special case
  //   would briefly enable the icon for a freshly-spawned AP that hasn't
  //   started its first turn. The rule the user sees:
  //     New / spinning up / mid-turn → disabled
  //     Turn finished                 → enabled
  //     Next turn starts              → disabled again
  const worker = (process.workerStatus ?? process.worker_status) as WorkerStatus | undefined;
  const workerTurnDone =
    worker === WorkerStatus.COMPLETE ||
    worker === WorkerStatus.IDLE ||
    worker === WorkerStatus.INTERRUPTED;
  const canResume =
    workerTurnDone ||
    (!!process.session_id && (status === ProcessStatus.STOPPED || status === ProcessStatus.FAILED));
  const canOpenTerminal =
    mode === WorkerMode.Interactive ? ready : canResume;

  const iconSpinning =
    label === 'Running' ||
    label === 'Starting' ||
    label === 'Stopping' ||
    label === 'Thinking' ||
    label === 'Running tool' ||
    label === 'Initializing' ||
    label === 'API retry';

  return (
    <div
      className={cn('flex items-center', styles.gap, className)}
      data-testid={dataTestId ?? 'process-status-line'}
    >
      <Icon
        className={cn(styles.icon, colorClass, iconSpinning && 'animate-spin', 'shrink-0')}
        aria-hidden
      />
      <span className={cn(styles.text, colorClass, 'font-medium shrink-0')}>{label}</span>

      {secondary && (
        <span className={cn(styles.secondary, 'min-w-0 flex-1 truncate text-muted-foreground')}>
          {secondary}
        </span>
      )}
      {elapsed && (
        <span className={cn(styles.secondary, 'ml-auto shrink-0 text-muted-foreground tabular-nums')}>
          {elapsed}
        </span>
      )}

      {onOpenInTerminal && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={!canOpenTerminal}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInTerminal();
                }}
                data-testid="process-status-line-open-terminal"
                className={cn(
                  'shrink-0 flex items-center justify-center rounded',
                  styles.btn,
                  'text-muted-foreground hover:bg-muted hover:text-foreground',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
                  !elapsed && 'ml-auto',
                )}
                aria-label={
                  canOpenTerminal
                    ? mode === WorkerMode.Interactive
                      ? 'Focus terminal'
                      : canResume && !ready
                        ? 'Resume in terminal'
                        : 'Open in terminal'
                    : `Busy — worker is ${label.toLowerCase()}`
                }
              >
                <Terminal className={styles.btnIcon} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {canOpenTerminal
                ? mode === WorkerMode.Interactive
                  ? 'Focus terminal'
                  : canResume && !ready
                    ? 'Resume in terminal'
                    : 'Open in terminal'
                : `Busy — worker is ${label.toLowerCase()}`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
