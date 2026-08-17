import { AgenticProcess, WORKER_STATUS_LABEL, WorkerStatus } from '@sdk';
import { useEffect, useState, type ReactNode } from 'react';
import { DotPulse } from '@src/components/dot-pulse';
import { getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import { formatClock } from '@src/components/lens-viewer/shared/format-utils';
import type { CurrentActivity } from './current-activity';

/**
 * Worker statuses that describe a FINISHED turn. Seeing one while the activity
 * line is up means we are reading a stale value, not a live phase.
 * `PENDING_USER` belongs here too: the turn has yielded back to the user.
 */
const TERMINAL_STATUSES = new Set<WorkerStatus>([
  WorkerStatus.COMPLETE,
  WorkerStatus.INTERRUPTED,
  WorkerStatus.INACTIVE,
  WorkerStatus.IDLE,
  WorkerStatus.PENDING_USER,
]);

function isTerminalStatus(status: WorkerStatus | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
}

interface ChatActivityLineProps {
  process: AgenticProcess;
  /** From `useTurnActivity` — whether a turn is in flight. */
  active: boolean;
  /** Epoch ms the current turn started (for the elapsed clock). */
  startedAt: number | null;
  /** Live worker status for the phase label. */
  status: WorkerStatus | null;
  /** The operation in flight right now, from `describeCurrentActivity`. When
   *  set it replaces the generic phase label with "Editing · foo.ts". Null
   *  between tools, and absent on surfaces that render their live events
   *  inline (they already show the operation). */
  activity?: CurrentActivity | null;
  /** Optional content rendered inline right after the elapsed clock. Only
   *  rendered while the line itself is visible (active). */
  trailing?: ReactNode;
}

/**
 * The bottom-of-chat "agent is working" line: animated dots + what the agent is
 * doing + an elapsed clock for the current turn.
 *
 * The label prefers the CONCRETE operation in flight ("Editing · foo.ts",
 * "Running · npm test") and falls back to the coarse worker phase (Thinking /
 * Using tool / …) between tools, so the line always says something and says the
 * most specific thing it can. Renders nothing when idle. Driven by
 * `useTurnActivity` (lifted to the pane so the list can scroll it into view).
 */
export function ChatActivityLine({ process, active, startedAt, status, activity, trailing }: ChatActivityLineProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const workerStatus = status ?? process.workerStatus;
  // This line only renders while a turn is in flight, so a status that means
  // "the turn ended" cannot be describing THIS turn — it is the previous one's
  // final status, which survives the turn boundary on the entity and is what a
  // resumed session hydrates with before the new turn reports in. Rendering it
  // verbatim printed "Complete" under a live pulse. Fall back to the neutral
  // in-flight word until the worker says something that can be true right now.
  const label = isTerminalStatus(workerStatus)
    ? WORKER_STATUS_LABEL[WorkerStatus.WORKING]
    : getStatusLabel({
        status: process.status,
        workerStatus,
        session_id: process.session_id,
      });
  const elapsed = startedAt != null ? formatClock(now - startedAt) : null;
  const ActivityIcon = activity?.icon;

  // Flex discipline, and the reason the detail is readable at all: every fixed
  // part is `shrink-0` and the detail is the ONE flexible item (`flex-1
  // min-w-0`), so it absorbs whatever width the pane has and truncates instead
  // of pushing the clock and chip out of view. A flex item defaults to
  // `min-width: auto`, so without `min-w-0` a long path or command simply
  // refuses to shrink and overflows the pane — a fixed `max-w` doesn't fix
  // that, it only clips earlier on wide panes.
  return (
    <div
      className="mt-1 flex w-full min-w-0 items-center gap-1.5 overflow-hidden py-2 text-xs text-muted-foreground"
      data-testid="chat-activity-line"
      aria-live="polite"
    >
      <DotPulse className="flex-shrink-0" />
      {activity ? (
        <>
          {ActivityIcon && <ActivityIcon className="h-3.5 w-3.5 flex-shrink-0" />}
          <span data-testid="chat-activity-label" className="flex-shrink-0 whitespace-nowrap">
            {activity.label}
          </span>
          {activity.detail && (
            <span
              data-testid="chat-activity-detail"
              title={activity.title}
              className="min-w-0 flex-1 truncate font-mono text-[11px] opacity-80"
            >
              {activity.detail}
            </span>
          )}
        </>
      ) : (
        <span data-testid="chat-activity-label" className="min-w-0 flex-1 truncate">
          {label}
        </span>
      )}
      {elapsed && <span className="flex-shrink-0 tabular-nums opacity-70">· {elapsed}</span>}
      {trailing && <span className="flex-shrink-0">{trailing}</span>}
    </div>
  );
}
