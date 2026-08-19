import { AgenticProcess, WORKER_STATUS_LABEL, WorkerStatus } from '@sdk';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DotPulse } from '@src/components/dot-pulse';
import { getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import { formatClock } from '@src/components/lens-viewer/shared/format-utils';
import { useHarnessLoginOnAuthError } from '@src/components/harness-login/use-harness-login-on-auth-error';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { describeCurrentActivity } from './current-activity';
import { useStickyActivity } from './hooks/useStickyActivity';
import { useTurnActivity } from './hooks/useTurnActivity';

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
  // ERROR and API_TIMEOUT belong here for exactly the reason the others do, and
  // their absence is what put a red "Error" under a live pulse. A turn that
  // failed while LOGGED OUT leaves ``stop_reason: stop_sequence`` as the last
  // assistant entry; ``worker_status`` walks back to it and reports ERROR until
  // the NEW turn writes its first entry — so the message you just sent wore the
  // previous one's failure for a second, then flipped to "Working".
  WorkerStatus.ERROR,
  WorkerStatus.API_TIMEOUT,
]);

function isTerminalStatus(status: WorkerStatus | null | undefined): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
}

interface ChatActivityLineProps {
  /** The only input. Everything the line shows is derived from this entity. */
  process: AgenticProcess;
  /** Optional content rendered inline right after the elapsed clock. Only
   *  rendered while the line itself is visible (active). */
  trailing?: ReactNode;
}

/**
 * Everything the line needs, sourced from the process itself.
 *
 * The line used to be handed `active` / `startedAt` / `status` / `activity` as
 * props, each computed in whichever pane rendered it. That coupled the readout
 * to the CHAT GROUPER: the panes fed it `splitLiveGroup(useTurnGroups(items))`,
 * and the grouper deliberately drops frames the chat represents elsewhere — a
 * skill call, which `MetaMessageChip` already shows — so those operations could
 * never be named here no matter what `describeEvent` knew about them.
 *
 * Subscribing to `flowDataStream` instead reads what the agent actually did,
 * before any rendering concern has filtered it. Grouping is for the transcript;
 * this line is not the transcript. Nothing below is new logic — it is the exact
 * composition the two panes each performed, moved to the one component that
 * consumes it.
 *
 * Not exported and not in `hooks/`: it has exactly one caller, and a module of
 * its own would be indirection with nothing to justify it.
 */
function useLiveActivity(process: AgenticProcess) {
  const turn = useTurnActivity(process);
  const items = useAgenticProcessStream(process);
  const current = useMemo(
    () => describeCurrentActivity(items, turn.startedAt, turn.status),
    [items, turn.startedAt, turn.status],
  );
  return { ...turn, activity: useStickyActivity(current, turn.startedAt) };
}

/**
 * The bottom-of-chat "agent is working" line: animated dots + what the agent is
 * doing + an elapsed clock for the current turn.
 *
 * The label prefers the CONCRETE operation in flight ("Editing · foo.ts",
 * "Running · npm test") and falls back to the coarse worker phase (Thinking /
 * Using tool / …) between tools, so the line always says something and says the
 * most specific thing it can. Renders nothing when idle.
 *
 * Takes the process and nothing else — see {@link useLiveActivity}.
 */
export function ChatActivityLine({ process, trailing }: ChatActivityLineProps) {
  const { active, startedAt, status, activity } = useLiveActivity(process);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  // A signed-out harness is the one failure the user can fix themselves, and
  // the CLI already named it. Called before the visibility branch so the hook
  // order stays stable whether or not the activity line renders.
  useHarnessLoginOnAuthError(process.worker_status_detail ?? process.workerStatusDetail);

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
