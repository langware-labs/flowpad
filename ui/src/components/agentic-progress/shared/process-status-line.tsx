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
 *   INACTIVE / API_TIMEOUT``) — or ``PENDING_USER``, which means the turn
 *   ended cleanly and it's now the user's turn — the *worker* drives the main
 *   label — the run is effectively over regardless of how late the backend
 *   transitions the lifecycle from ``RUNNING`` → ``STOPPED``. No subscript in
 *   that case. ``PENDING_USER`` is deliberately excluded from
 *   ``isWorkerTerminal`` (that set gates the ``is_ready_for_input`` queue
 *   predicate), but for *display* it is a settled, turn-done state — without
 *   this the row spins a "Running" lifecycle label for the whole 5-minute
 *   PENDING_USER window after a headless run finishes.
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
  // "Run is over from the user's POV": worker terminal (COMPLETE / ERROR / …)
  // OR PENDING_USER (turn ended cleanly, now the user's turn). PENDING_USER is
  // out of isWorkerTerminal on purpose — that set drives is_ready_for_input —
  // but for display it's a settled state, so it must promote the same way or
  // the row keeps spinning "Running" for the 5-min post-completion window.
  const workerDone =
    worker !== undefined && (isWorkerTerminal(worker) || worker === WorkerStatus.PENDING_USER);

  // Promote the worker config to the main slot when the run is over even if the
  // lifecycle hasn't transitioned to STOPPED yet. No subscript in that case.
  const mainConfig = workerDone && workerConfig ? workerConfig : procConfig;
  const subConfig =
    !workerDone && workerConfig && workerConfig.label !== procConfig.label
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
  //   reported COMPLETE / INTERRUPTED / PENDING_USER for a real turn, OR the
  //   lifecycle reached STOPPED / FAILED with a session to resume. We exclude
  //   `WorkerStatus.IDLE` deliberately — the Python side uses IDLE as the
  //   *default* / "never ran" projection (see flow_sdk/.../agentic_process.py
  //   `worker_status` fallback). Treating IDLE as "ready" would enable the
  //   icon on a brand-new AP that hasn't started its first turn. PENDING_USER
  //   IS admitted: it's the backend's 5-minute projection of a just-finished
  //   COMPLETE turn (the worker is alive and resumable, awaiting the next user
  //   message) — exactly the "open/resume in terminal" case. The rule the user
  //   sees:
  //     New / IDLE / spinning up / mid-turn → disabled
  //     Turn finished (COMPLETE / PENDING_USER) → enabled
  //     Next turn kicked off                 → disabled (executeInstruction
  //                                             optimistically flips workerStatus
  //                                             to WORKING immediately)
  //     That next turn finishes              → enabled
  const workerTurnDone =
    worker === WorkerStatus.COMPLETE ||
    worker === WorkerStatus.INTERRUPTED ||
    worker === WorkerStatus.PENDING_USER;
  // INACTIVE is a finished/aged turn (PENDING_USER that aged past the 5-min
  // window, or a stale session). Its worker status was derived from a transcript
  // that still lives locally, and ``session_id`` is the resumable handle — so
  // when we still have that session on this machine we can re-open / resume it
  // in a terminal just like a freshly-done turn.
  const resumableInactive =
    worker === WorkerStatus.INACTIVE && !!process.session_id;
  const canResume =
    workerTurnDone ||
    resumableInactive ||
    (!!process.session_id && (status === ProcessStatus.STOPPED || status === ProcessStatus.FAILED));
  // Interactive (visible=true): the tab already exists, so a click just
  // re-focuses it — allow it whenever the worker is ready OR the turn is done
  // (incl. PENDING_USER, or an INACTIVE turn we still hold the session for).
  // Without this the icon goes dead once the user opens the terminal (which
  // flips the process to visible=true) and the worker settles into PENDING_USER
  // / ages to INACTIVE — ``ready`` excludes both — so returning to the
  // conversation would show a disabled icon for an open tab.
  const canOpenTerminal =
    mode === WorkerMode.Interactive
      ? ready || workerTurnDone || resumableInactive
      : canResume;

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
