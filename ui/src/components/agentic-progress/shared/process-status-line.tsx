import { getWorkerMode, isReadyForInput, isWorkerTerminal, ProcessStatus, type StatusBearingProcess, WorkerMode, WorkerStatus } from '@sdk';
import { cn } from '@src/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { Terminal } from 'lucide-react';
import { getStatusLabel, processStatusConfig, workerStatusConfig } from './status-indicator';

/**
 * Reusable one-liner status line for an AgenticProcess.
 *
 * Renders (left-to-right):
 *   [Icon] [MainLabel] [<sub>workerSubscript</sub>]  [secondary]  [elapsed]  [Open-in-Terminal button]
 *
 * Label rule (so the UI matches the user's intuition about "the run is done"):
 * - If ``workerStatus`` is terminal (``COMPLETE / ERROR / INTERRUPTED /
 *   INACTIVE / API_TIMEOUT``), the *worker* drives the main label — the run is
 *   effectively over regardless of how late the backend transitions the
 *   lifecycle from ``RUNNING`` → ``STOPPED``. No subscript in that case.
 * - Otherwise the lifecycle (``processStatusConfig[process.status]``) drives
 *   the main label; ``workerStatus`` is appended as a smaller, worker-coloured
 *   subscript via ``<sub>``, but only when defined, not ``UNKNOWN``, and
 *   distinct from the main label (identical labels collapse to a single token).
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
    worker: 'text-[10px]',
    secondary: 'text-[11px]',
    icon: 'h-3 w-3',
    btn: 'h-5 w-5',
    btnIcon: 'h-3 w-3',
    gap: 'gap-1.5',
  },
  md: {
    text: 'text-sm',
    worker: 'text-[11px]',
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
  const status = (process.status as ProcessStatus | undefined) ?? ProcessStatus.NEW;
  const procConfig = processStatusConfig[status] ?? processStatusConfig[ProcessStatus.NEW];

  const worker = (process.workerStatus ?? process.worker_status) as WorkerStatus | undefined;
  const workerConfig =
    worker && worker !== WorkerStatus.UNKNOWN ? workerStatusConfig[worker] : undefined;
  const workerTerminal = worker !== undefined && isWorkerTerminal(worker);

  // Promote the worker config to the main slot when the worker is terminal
  // (COMPLETE / ERROR / …) — the run is over from the user's POV even if the
  // lifecycle hasn't transitioned to STOPPED yet. No subscript in that case.
  const mainConfig = workerTerminal && workerConfig ? workerConfig : procConfig;
  const subConfig =
    !workerTerminal && workerConfig && workerConfig.label !== procConfig.label
      ? workerConfig
      : undefined;

  const MainIcon = mainConfig.icon;
  const mainLabel = mainConfig.label;
  const mainColor = mainConfig.color;

  // Tooltip text uses the fine-grained label so "Busy — worker is …" still
  // describes what the worker is actually doing.
  const tooltipLabel = getStatusLabel(process);

  const ready = isReadyForInput(process);
  const mode = getWorkerMode(process);
  const styles = sizeStyles[size];
  // Two distinct gates depending on worker mode:
  // - Interactive PTY (visible=true): clickable when the worker is ready for
  //   input — clicking just focuses the existing tab.
  // - Headless (visible=false): clickable ONLY when the worker has explicitly
  //   reported COMPLETE / INTERRUPTED for a real turn, OR the lifecycle
  //   reached STOPPED / FAILED with a session to resume. We exclude
  //   `WorkerStatus.IDLE` deliberately — the Python side uses IDLE as the
  //   *default* / "never ran" projection (see flow_sdk/.../agentic_process.py
  //   `worker_status` fallback). Treating IDLE as "ready" would enable the
  //   icon on a brand-new AP that hasn't started its first turn. The rule
  //   the user sees:
  //     New / IDLE / spinning up / mid-turn → disabled
  //     Turn finished (COMPLETE)             → enabled
  //     Next turn kicked off                 → disabled (executeInstruction
  //                                             optimistically flips workerStatus
  //                                             to WAITING immediately)
  //     That next turn finishes              → enabled
  const workerTurnDone =
    worker === WorkerStatus.COMPLETE ||
    worker === WorkerStatus.INTERRUPTED;
  const canResume =
    workerTurnDone ||
    (!!process.session_id && (status === ProcessStatus.STOPPED || status === ProcessStatus.FAILED));
  const canOpenTerminal =
    mode === WorkerMode.Interactive ? ready : canResume;

  const iconSpinning = mainConfig.animate === true;

  return (
    <div
      className={cn('flex items-center', styles.gap, className)}
      data-testid={dataTestId ?? 'process-status-line'}
    >
      <MainIcon
        className={cn(styles.icon, mainColor, iconSpinning && 'animate-spin', 'shrink-0')}
        aria-hidden
      />
      <span className={cn(styles.text, mainColor, 'font-medium shrink-0')}>{mainLabel}</span>
      {subConfig && (
        <span
          className={cn(
            styles.worker,
            subConfig.color,
            'font-medium shrink-0 -ml-0.5 self-end pb-px',
          )}
          data-testid="process-status-line-worker"
        >
          {subConfig.label}
        </span>
      )}

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
                    : `Busy — worker is ${tooltipLabel.toLowerCase()}`
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
                : `Busy — worker is ${tooltipLabel.toLowerCase()}`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
