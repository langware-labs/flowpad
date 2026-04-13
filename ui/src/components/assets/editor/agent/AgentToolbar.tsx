import { AgenticProcess, dataContext } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Play, Square } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

// ── Execution hook ─────────────────────────────────────────────────────────────

export interface AgentExecutionHandle {
  /** The live AgenticProcess instance (null until first send) */
  process: AgenticProcess | null;
  isRunning: boolean;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  /** Open panel; process created lazily on first send */
  run: () => void;
  stop: () => void;
  send: (message: string) => Promise<void>;
}

export function useAgentExecution(sourcePath: string): AgentExecutionHandle {
  const [process, setProcess] = useState<AgenticProcess | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const processRef = useRef<AgenticProcess | null>(null);
  processRef.current = process;

  const { data: liveProcess } = useEntity<AgenticProcess>(process?.typeId ?? null);
  const isRunning = !!process && !liveProcess?.waiting_for_prompt;

  const run = useCallback(() => {
    setPanelOpen(true);
  }, []);

  const stop = useCallback(() => {
    void processRef.current?.exit();
  }, []);

  const send = useCallback(
    async (message: string) => {
      let proc = processRef.current;

      if (!proc) {
        proc = await new AgenticProcess({
          workdir: dataContext.project?.fs_storage_mount_path,
        }).save([]);
        await proc.loadEmbeddedAgent(sourcePath);
        await proc.watch();
        setProcess(proc);
        processRef.current = proc;
      }

      await proc.executeInstruction(message, { sync: false });
    },
    [sourcePath],
  );

  return { process, isRunning, panelOpen, setPanelOpen, run, stop, send };
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
