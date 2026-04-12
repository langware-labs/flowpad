import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { dataManager, Flow, FlowMode, ICompletionOptions, TypeId } from '@sdk';
import { useProcess, useProcessExecution } from '@sdk/react/hooks';
import { Play, Square } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

// ── Execution hook ─────────────────────────────────────────────────────────────

export interface AgentExecutionHandle {
  /** The live Flow instance (null until first send) */
  flow: Flow | null;
  isRunning: boolean;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /** Open panel and create flow on first call; subsequent calls reuse the flow */
  run: () => void;
  stop: () => void;
  send: (message: string) => Promise<void>;
}

export function useAgentExecution(sourcePath: string): AgentExecutionHandle {
  const { agent, project } = useAgentContext();

  const [flowTypeId, setFlowTypeId] = useState<TypeId | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // Keep a ref to the latest flowTypeId so callbacks don't go stale
  const flowTypeIdRef = useRef<TypeId | null>(null);
  flowTypeIdRef.current = flowTypeId;

  const { data: flow } = useProcess(flowTypeId);
  // Keep a stable ref to the live flow for use inside callbacks
  const flowRef = useRef<Flow | null>(null);
  flowRef.current = flow ?? null;

  const { isRunning } = useProcessExecution(flow ?? null);

  const run = useCallback(() => {
    setPanelOpen(true);
  }, []);

  const stop = useCallback(() => {
    flowRef.current?.cancel();
  }, []);

  const send = useCallback(
    async (message: string) => {
      if (!project || !agent) return;

      let liveFlow = flowRef.current;

      // First send: create the flow, then fetch the live instance directly —
      // don't wait for React state to propagate (avoids race condition).
      if (!flowTypeIdRef.current) {
        const typeId = await project.createFlow(agent.typeId.id, sourcePath);
        setFlowTypeId(typeId);
        flowTypeIdRef.current = typeId;
        liveFlow = await dataManager.getByTypeId<Flow>(typeId);
      }

      if (!liveFlow) return;
      await liveFlow.sendMessage(message, {
        processId: liveFlow.id,
        flowMode: FlowMode.AGENT,
      } as ICompletionOptions);
    },
    [project, agent, sourcePath],
  );

  return { flow: flow ?? null, isRunning, panelOpen, setPanelOpen, run, stop, send };
}

// ── Toolbar component ──────────────────────────────────────────────────────────

interface AgentToolbarProps {
  execution: AgentExecutionHandle;
}

export function AgentToolbar({ execution }: AgentToolbarProps) {
  const { isRunning, panelOpen, run, stop, setPanelOpen } = execution;

  const handleClick = () => {
    if (isRunning) {
      stop();
    } else if (panelOpen) {
      setPanelOpen(false);
    } else {
      run();
    }
  };

  return (
    <button
      title={isRunning ? 'Stop agent' : panelOpen ? 'Close panel' : 'Run agent'}
      onClick={handleClick}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
        isRunning
          ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
          : 'bg-primary/10 text-primary hover:bg-primary/20'
      }`}
    >
      {isRunning ? (
        <>
          <Square className="h-3 w-3 fill-current" />
          Stop
        </>
      ) : (
        <>
          <Play className="h-3 w-3 fill-current" />
          Run
        </>
      )}
    </button>
  );
}
