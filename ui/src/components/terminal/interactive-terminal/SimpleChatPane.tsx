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
import { notify } from '@src/notifications/notify';
import { Check, Copy, MessageSquare } from 'lucide-react';
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
        notify.error({ title: 'Message not sent', message: err instanceof Error ? err.message : String(err) });
      } finally {
        setSending(false);
      }
    },
    [process, sending],
  );

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      // Route formatting through the standard transcript method, not the live
      // FlowData stream: fetch the parsed transcript and render clean chat text.
      const transcript = await process.getTranscript();
      await navigator.clipboard.writeText(transcript.toText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[SimpleChatPane] copy failed', err);
      notify.error({ title: 'Could not copy chat', message: err instanceof Error ? err.message : String(err) });
    }
  }, [process]);

  const handleStop = useCallback(async () => {
    try {
      await process.interruptTurn();
    } catch (err) {
      console.error('[SimpleChatPane] interrupt failed', err);
      notify.error({ title: 'Could not stop', message: err instanceof Error ? err.message : String(err) });
    }
  }, [process]);

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
        {turnGroups.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <MessageSquare className="h-6 w-6" />
            </div>
            <div>
              <p className="text-[15px] font-medium text-foreground">Start a conversation</p>
              <p className="mt-1 text-sm">Send a message below and the agent will get to work.</p>
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[45rem] px-4 py-3">
            <TurnGroupsList groups={turnGroups} />
          </div>
        )}
      </AutoScrollContainer>
      <div className="mx-auto w-full max-w-[45rem]">
      <CompactExecutionInput
        onSend={handleSend}
        disabled={sending || busy}
        running={busy}
        onStop={handleStop}
        placeholder="Message the agent…"
        statusSlot={
          <div className="flex items-center gap-1">
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
            {turnGroups.length > 0 && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  void handleCopy();
                }}
                title="Copy chat as text"
                aria-label="Copy chat as text"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                data-testid="simple-chat-copy"
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </button>
            )}
          </div>
        }
      />
      </div>
    </div>
  );
}
