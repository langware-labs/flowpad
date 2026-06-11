import {
  AgenticProcess,
  isWorkerRunning,
  type StatusBearingProcess,
  TypeId,
  WorkerStatus,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { AutoScrollContainer, AutoScrollContainerHandle } from '@src/components/AutoScrollContainer';
import { ProcessStatusIndicator, getStatusLabel } from '@src/components/agentic-progress/shared/status-indicator';
import { CompactExecutionInput } from '@src/components/entity-execution-panel/CompactExecutionInput';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';
import { useDerivedWorkerStatus } from '@src/components/entity-execution-panel/hooks/useDerivedWorkerStatus';
import { groupTurnEvents } from '@src/components/floating-chat/groupTurnEvents';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { cn } from '@src/lib/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface SimpleChatPaneProps {
  /** The interactive tab's live PTY AgenticProcess. */
  process: AgenticProcess;
  className?: string;
}

/**
 * Standard-mode "simple view" of an interactive terminal tab: the same chat
 * surface the floating Flowpad Assistant uses (dense message + tool-chip
 * rows), bound to the tab's existing PTY AgenticProcess instead of the xterm.
 *
 * Skin-layer contract (docs/viewmodes.md): this pane is an alternative
 * arrangement of the SAME session — it reads the process's existing
 * `flowDataStream` (history is hydrated by the tab's `useFlowDataTrace`;
 * `loadHistory` here is an idempotent safety net) and sends through the
 * standard `prompt()`, which the backend routes — for a visible PTY process —
 * into a stdin write to the same PTY the xterm types into, streaming the
 * turn's transcript delta back into that same stream. Toggling Advanced⇄
 * Standard never resets the terminal: the xterm stays mounted underneath,
 * this pane overlays it.
 */
export function SimpleChatPane({ process, className }: SimpleChatPaneProps) {
  // Idempotent — the tab's trace-gutter hook usually got here first.
  useEffect(() => {
    void process.loadHistory().catch((err) => {
      console.error('[SimpleChatPane] loadHistory failed', err);
    });
  }, [process.id]);

  const items = useAgenticProcessStream(process);
  const turnGroups = useMemo(() => groupTurnEvents(items), [items]);

  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (text: string) => {
      if (sending) return;
      setSending(true);
      try {
        await process.prompt(text);
      } catch (err) {
        console.error('[SimpleChatPane] prompt failed', err);
      } finally {
        setSending(false);
      }
    },
    [process, sending],
  );

  const scrollRef = useRef<AutoScrollContainerHandle>(null);
  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [turnGroups.length]);

  // Reflect the gold entity reactively — the prop comes from the loader
  // context and may not re-render on data_op patches (worker_status flips on
  // transcript transitions). Same pattern as EntityExecutionPanel.
  const processTypeId = useMemo(
    () => new TypeId(AgenticProcess.type, process.id),
    [process.id],
  );
  const { data: liveProcess } = useEntity<AgenticProcess>(processTypeId, { watch: true });
  const reflected = liveProcess ?? process;

  const derivedWorkerStatus = useDerivedWorkerStatus(process);
  const indicatorProcess: StatusBearingProcess = {
    status: reflected.status,
    workerStatus: derivedWorkerStatus ?? reflected.workerStatus,
    session_id: reflected.session_id,
  };
  // Same gate as the pty-poll EntityExecutionPanel: only an actively mid-turn
  // worker (gold isWorkerRunning) blocks the composer — a dead PTY is
  // relaunched by prompt(), so no status==RUNNING gate here.
  const busy = isWorkerRunning(indicatorProcess.workerStatus as WorkerStatus);

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col bg-background', className)}
      data-testid="simple-chat-pane"
    >
      <AutoScrollContainer ref={scrollRef} className="flex-1 overflow-y-auto">
        {turnGroups.length === 0 && (
          <div className="p-3 text-[11px] text-muted-foreground">
            No conversation yet. Send a message to the agent below.
          </div>
        )}
        <TurnGroupsList groups={turnGroups} />
      </AutoScrollContainer>
      <CompactExecutionInput
        onSend={handleSend}
        disabled={sending || busy}
        placeholder="Message the agent…"
        statusSlot={
          <span
            title={getStatusLabel(indicatorProcess)}
            className="flex items-center"
            data-testid="simple-chat-status"
          >
            <ProcessStatusIndicator
              process={indicatorProcess}
              showLabel
              size="sm"
              className="px-1 text-muted-foreground"
            />
          </span>
        }
      />
    </div>
  );
}
