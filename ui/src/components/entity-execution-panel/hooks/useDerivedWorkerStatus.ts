import { AgenticProcess, FlowDataSource, WorkerStatus, type FlowData } from '@sdk';
import { useEffect, useState } from 'react';

/**
 * For CLI-mode (``visible=false``) AgenticProcesses the server does not
 * re-serialize the entity during a turn, so ``worker_status`` never changes
 * on the client. The ``flowDataStream`` channel is live, though — every CLI
 * JSONL line arrives here as a FlowData item in real time.
 *
 * This reducer maps each incoming item back to the same ``WorkerStatus`` the
 * canonical ``_tail_status`` would return for that JSONL line, validated by
 * per-event correlation against the file tail.
 */
function deriveFromItem(item: FlowData | undefined, prev: WorkerStatus): WorkerStatus {
  if (!item) return prev;
  const et = item.elementType;
  const attrs = item.attributes ?? {};
  const role = attrs.role as string | undefined;
  const subtype = attrs.subtype as string | undefined;
  const stopReason = attrs.stop_reason as string | undefined;

  if (et === 'user-message' || (et === 'chat' && role === 'user')) {
    return WorkerStatus.WORKING;
  }
  if (et === 'tool-call') {
    return WorkerStatus.TOOL_CALL;
  }
  if (et === 'progress') {
    return WorkerStatus.TOOL_RUNNING;
  }
  // Claude Code writes the tool result as a user-role record; _tail_status
  // returns WORKING on that, and the next event is almost always the
  // assistant's continuation (THINKING).
  if (et === 'tool-result') {
    return WorkerStatus.WORKING;
  }
  if (et === 'chat' && role === 'assistant') {
    if (stopReason === 'end_turn') return WorkerStatus.COMPLETE;
    if (stopReason === 'stop_sequence') return WorkerStatus.ERROR;
    if (stopReason === 'tool_use') return WorkerStatus.TOOL_CALL;
    return WorkerStatus.THINKING;
  }
  if (et === 'result') {
    if (subtype === 'error') return WorkerStatus.ERROR;
    return WorkerStatus.COMPLETE;
  }
  if (et === 'status' && subtype === 'api_error') {
    return WorkerStatus.API_ERROR;
  }
  // Other `status` subtypes (hook_started / hook_response / init / rate-limit)
  // and plain `end` markers carry no state-transition signal.
  return prev;
}

/**
 * Live ``WorkerStatus`` derived from the process' FlowData stream.
 *
 * Returns ``null`` when there is no process yet. On a process change, seeds
 * from ``process.workerStatus`` (whatever the last entity patch said) and
 * then keeps itself in sync via the ``flowDataStream`` 'data' event.
 */
export function useDerivedWorkerStatus(
  process: AgenticProcess | null,
): WorkerStatus | null {
  const [derived, setDerived] = useState<WorkerStatus | null>(() => {
    return (process?.workerStatus as WorkerStatus | undefined) ?? null;
  });

  useEffect(() => {
    if (!process) {
      setDerived(null);
      return;
    }
    setDerived((process.workerStatus as WorkerStatus | undefined) ?? WorkerStatus.IDLE);

    const onData = () => {
      const items = process.flowDataStream.items as FlowData[];
      const last = items[items.length - 1];
      // History replay fires 'data' for every historical event. Those items
      // lack live-stream signals (stop_reason on assistant turns) and would
      // wrongly transition the indicator into THINKING. Skip them — the
      // entity's own workerStatus already reflects the terminal state.
      if (last?.source === FlowDataSource.History) return;
      setDerived((prev) => deriveFromItem(last, prev ?? WorkerStatus.IDLE));
    };
    const onClear = () => {
      setDerived((process.workerStatus as WorkerStatus | undefined) ?? WorkerStatus.IDLE);
    };

    process.flowDataStream.on('data', onData);
    process.flowDataStream.on('clear', onClear);
    return () => {
      process.flowDataStream.off('data', onData);
      process.flowDataStream.off('clear', onClear);
    };
  }, [process]);

  return derived;
}
