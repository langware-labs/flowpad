import { AgenticProcess, WorkerStatus } from '@sdk';
import { useEffect, useState, type ReactNode } from 'react';
import { DotPulse } from '@src/components/dot-pulse';
import { getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import { formatClock } from '@src/components/lens-viewer/shared/format-utils';

interface ChatActivityLineProps {
  process: AgenticProcess;
  /** From `useTurnActivity` — whether a turn is in flight. */
  active: boolean;
  /** Epoch ms the current turn started (for the elapsed clock). */
  startedAt: number | null;
  /** Live worker status for the phase label. */
  status: WorkerStatus | null;
  /** Optional content pinned to the right of the row. Only rendered while the
   *  line itself is visible (active). */
  trailing?: ReactNode;
}

/**
 * The bottom-of-chat "agent is working" line: animated dots + the live phase
 * label (Thinking / Using tool / …) + an elapsed clock for the current turn.
 * Renders nothing when idle. Driven by `useTurnActivity` (lifted to the pane so
 * the list can scroll it into view).
 */
export function ChatActivityLine({ process, active, startedAt, status, trailing }: ChatActivityLineProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const label = getStatusLabel({
    status: process.status,
    workerStatus: status ?? process.workerStatus,
    session_id: process.session_id,
  });
  const elapsed = startedAt != null ? formatClock(now - startedAt) : null;

  return (
    <div
      className="mt-1 flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground"
      data-testid="chat-activity-line"
      aria-live="polite"
    >
      <DotPulse />
      <span>{label}</span>
      {elapsed && <span className="tabular-nums opacity-70">· {elapsed}</span>}
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
