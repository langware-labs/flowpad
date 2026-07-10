import { AgenticProcess, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { AutoScrollContainer, AutoScrollContainerHandle } from '@src/components/AutoScrollContainer';
import { ChatActivityLine } from '@src/components/entity-execution-panel/ChatActivityLine';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';
import { useTurnActivity } from '@src/components/entity-execution-panel/hooks/useTurnActivity';
import { groupTurnEvents } from '@src/components/floating-chat/groupTurnEvents';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { cn } from '@src/lib/utils';
import { Trans } from '@lingui/react/macro';
import { MessageSquare } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { PlanInteractionBar } from './PlanInteractionBar';

interface SimpleChatPaneProps {
  /** The interactive tab's live PTY AgenticProcess. */
  process: AgenticProcess;
  className?: string;
}

/**
 * Standard-mode "simple view" of an interactive terminal tab: the message list
 * (dense message + tool-chip rows) bound to the tab's existing PTY
 * AgenticProcess instead of the xterm. The composer lives in the shared
 * TerminalBottomRibbon (see ChatComposerBar) so chat + terminal present one
 * unified bottom ribbon.
 *
 * Skin-layer contract (docs/viewmodes.md): this pane is an alternative
 * arrangement of the SAME session — it reads the process's existing
 * `flowDataStream` (history hydrated by the tab's `useFlowDataTrace`;
 * `loadHistory` here is an idempotent safety net). Toggling Advanced⇄Standard
 * never resets the terminal: the xterm stays mounted underneath, this pane
 * overlays it.
 */
export function SimpleChatPane({ process, className }: SimpleChatPaneProps) {
  // Idempotent — the tab's trace-gutter hook usually got here first.
  useEffect(() => {
    void process.loadHistory().catch((err) => {
      console.error('[SimpleChatPane] loadHistory failed', err);
    });
  }, [process.id]);

  // A browser reload closes the HTTP response stream while the backend turn
  // continues. Entity updates still announce the terminal worker state, but
  // no stream consumer remains to append the final frames. Reconcile once on
  // that terminal transition so the remounted chat converges automatically.
  const processTypeId = useMemo(() => new TypeId(AgenticProcess.type, process.id), [process.id]);
  const { data: liveProcess } = useEntity<AgenticProcess>(processTypeId, { watch: true });
  const workerStatus = liveProcess?.workerStatus;
  const reconciledStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!liveProcess?.completed || !workerStatus || reconciledStatusRef.current === workerStatus) return;
    reconciledStatusRef.current = workerStatus;
    void process.loadHistory({ force: true }).catch((err) => {
      console.error('[SimpleChatPane] completion history reconcile failed', err);
    });
  }, [liveProcess?.completed, process, workerStatus]);

  const items = useAgenticProcessStream(process);
  const turnGroups = useMemo(() => groupTurnEvents(items), [items]);
  const activity = useTurnActivity(process);

  const scrollRef = useRef<AutoScrollContainerHandle>(null);
  useEffect(() => {
    scrollRef.current?.scrollToBottom();
  }, [turnGroups.length, activity.active]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-background', className)} data-testid="simple-chat-pane">
      <AutoScrollContainer ref={scrollRef} className="flex-1 overflow-y-auto">
        {turnGroups.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <MessageSquare className="h-6 w-6" />
            </div>
            <div>
              <p className="text-[15px] font-medium text-foreground"><Trans>Start a conversation</Trans></p>
              <p className="mt-1 text-sm"><Trans>Send a message below and the agent will get to work.</Trans></p>
            </div>
          </div>
        ) : (
          <div className="w-full px-4 py-3">
            <TurnGroupsList groups={turnGroups} worker={process.worker_type ?? undefined} />
            <ChatActivityLine
              process={process}
              active={activity.active}
              startedAt={activity.startedAt}
              status={activity.status}
            />
          </div>
        )}
      </AutoScrollContainer>
      <PlanInteractionBar items={items} />
    </div>
  );
}
