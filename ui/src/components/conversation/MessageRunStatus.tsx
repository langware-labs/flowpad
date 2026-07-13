import { useLingui } from '@lingui/react/macro';
import { DoorOpen } from 'lucide-react';
import { FlowMessage, type AgenticProcess, type StatusBearingProcess, type WorkerStatus } from '@sdk';
import {
  ProcessStatusIndicator,
} from '@src/components/agentic-progress/shared/status-indicator';
import { isPromptExecuted } from './attachment-actions/prompt-attachment';

/**
 * The per-message run-status one-liner that takes the place of the "Execute"
 * button once a prompt message has been executed. Executing approves the prompt
 * (so the Execute CTA self-hides) and spawns/reuses one headless run for the
 * conversation — this shows that run's live status and, on click, re-opens it in
 * the drawer's Runs tab (via `onOpenRun`). Purely presentational: the parent
 * ({@link ConversationView}) resolves the conversation's run + derived status
 * ONCE and passes them in, so N executed bubbles don't each subscribe. Renders
 * nothing until the message carried a prompt, that prompt is approved, and a run
 * exists.
 */
export function MessageRunStatus({
  fm,
  run,
  runStatus,
  onOpenRun,
  onOpenWorkerSession,
  workerSessionInFlight = false,
}: {
  fm: FlowMessage | null;
  /** The conversation's run, resolved once by the parent. */
  run: AgenticProcess | null;
  /** Live worker status for `run`, derived once by the parent. */
  runStatus?: WorkerStatus | null;
  /** Open the run in the conversation drawer's Runs tab, focused on it. */
  onOpenRun?: (processId: string) => void;
  /** Additive: open the worker session's view in the collaboration room. When
   *  set, renders a second icon after the status line. Leaves the drawer path
   *  (`onOpenRun`) untouched. */
  onOpenWorkerSession?: () => void;
  /** Pulse the worker-session icon while the session is mid-turn. */
  workerSessionInFlight?: boolean;
}) {
  const { t } = useLingui();
  if (!isPromptExecuted(fm) || !run) return null;

  const indicator: StatusBearingProcess = {
    status: run.status,
    workerStatus: runStatus ?? run.workerStatus,
    session_id: run.session_id,
  };

  // Live agent-progress counters (backend-computed projection; already a
  // ProcessCounters instance via parseStatusReport). Shown only once there's a
  // non-empty snapshot so the row doesn't flash "0 tok · 0 msgs".
  const counters = run.statusReport?.counters ?? null;
  const countersLabel = counters && counters.totalTokens > 0 ? counters.formatted() : null;

  return (
    <span className="mt-1.5 inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => run.id && onOpenRun?.(run.id)}
        title={t`Already executed — open the run`}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        data-testid="message-run-status"
      >
        <span>{t`Executed`}</span>
        <span className="opacity-70">·</span>
        <ProcessStatusIndicator process={indicator} showLabel size="sm" />
        {countersLabel && (
          <>
            <span className="opacity-70">·</span>
            <span className="tabular-nums opacity-80" data-testid="message-run-counters">
              {countersLabel}
            </span>
          </>
        )}
      </button>
      {onOpenWorkerSession && (
        <button
          type="button"
          onClick={onOpenWorkerSession}
          title={t`Open worker session`}
          aria-label={t`Open worker session`}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-70 transition-opacity hover:bg-accent hover:text-foreground hover:opacity-100"
          data-testid="message-open-worker-session"
        >
          <DoorOpen className={`h-3 w-3${workerSessionInFlight ? ' animate-pulse' : ''}`} />
        </button>
      )}
    </span>
  );
}
