import {
  AgenticProcess,
  isWorkerRunning,
  type StatusBearingProcess,
  TypeId,
  WorkerStatus,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ProcessStatusIndicator, getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import { CompactExecutionInput } from '@src/components/entity-execution-panel/CompactExecutionInput';
import { useDerivedWorkerStatus } from '@src/components/entity-execution-panel/hooks/useDerivedWorkerStatus';
import { notify } from '@src/notifications/notify';
import { useCallback, useMemo, useState } from 'react';

interface ChatComposerBarProps {
  /** The interactive tab's live PTY AgenticProcess. */
  process: AgenticProcess;
}

/**
 * The chat composer for an interactive agent tab, lifted out of SimpleChatPane so
 * it can live inside the shared TerminalBottomRibbon (one unified bottom ribbon
 * instead of two stacked rows). Sends through the standard `prompt()` (routed to
 * the PTY for a visible process) and interrupts the in-flight turn via
 * `interruptTurn()`. Status + busy come from the gold entity, reflected live.
 */
export function ChatComposerBar({ process }: ChatComposerBarProps) {
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (text: string) => {
      if (sending) return;
      setSending(true);
      try {
        await process.prompt(text);
      } catch (err) {
        console.error('[ChatComposerBar] prompt failed', err);
        notify.error({ title: 'Message not sent', message: err instanceof Error ? err.message : String(err) });
      } finally {
        setSending(false);
      }
    },
    [process, sending],
  );

  const handleStop = useCallback(async () => {
    try {
      await process.interruptTurn();
    } catch (err) {
      console.error('[ChatComposerBar] interrupt failed', err);
      notify.error({ title: 'Could not stop', message: err instanceof Error ? err.message : String(err) });
    }
  }, [process]);

  // Reflect the gold entity reactively — the prop comes from the loader context
  // and may not re-render on data_op patches (worker_status flips on transcript
  // transitions). Same pattern as EntityExecutionPanel / SimpleChatPane.
  const processTypeId = useMemo(() => new TypeId(AgenticProcess.type, process.id), [process.id]);
  const { data: liveProcess } = useEntity<AgenticProcess>(processTypeId, { watch: true });
  const reflected = liveProcess ?? process;

  const derivedWorkerStatus = useDerivedWorkerStatus(process);
  const indicatorProcess: StatusBearingProcess = {
    status: reflected.status,
    workerStatus: derivedWorkerStatus ?? reflected.workerStatus,
    session_id: reflected.session_id,
  };
  // Only an actively mid-turn worker blocks the composer — a dead PTY is
  // relaunched by prompt(), so no status==RUNNING gate here.
  const busy = isWorkerRunning(indicatorProcess.workerStatus as WorkerStatus);

  return (
    <CompactExecutionInput
      bare
      onSend={handleSend}
      disabled={sending || busy}
      running={busy}
      onStop={handleStop}
      placeholder="Message the agent…"
      statusSlot={
        <span
          title={getStatusLabel(indicatorProcess)}
          className="flex items-center"
          data-testid="simple-chat-status"
        >
          <ProcessStatusIndicator process={indicatorProcess} showLabel size="sm" className="px-1 text-muted-foreground" />
        </span>
      }
    />
  );
}
