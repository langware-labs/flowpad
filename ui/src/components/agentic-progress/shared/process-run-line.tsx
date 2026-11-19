import { useMemo } from 'react';
import { AgenticProcess, isWorkerTerminal, ProcessStatus, TypeId } from '@sdk';
import type { WorkerStatus } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { getOneLiner } from '@src/components/hooks/event-utils';
import { useFlowDataTrace } from '@src/hooks/use-flow-data-trace';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { TraceEvent } from '@src/types/trace-event';
import { ProcessStatusLine } from './process-status-line';
import { processStatusConfig, workerStatusConfig } from './status-indicator';

function runStatusLabel(process: AgenticProcess): string {
  const status = (process.status as ProcessStatus | undefined) ?? ProcessStatus.NEW;
  const procConfig = processStatusConfig[status] ?? processStatusConfig[ProcessStatus.NEW];
  const worker = (process.workerStatus ?? process.worker_status) as WorkerStatus | undefined;
  const workerConfig = worker ? workerStatusConfig[worker] : undefined;
  return worker && workerConfig && isWorkerTerminal(worker) ? workerConfig.label : procConfig.label;
}

function runOneLiner(process: AgenticProcess, events: TraceEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const line = getOneLiner(events[i]).trim();
    // A raw protocol frame (rate limit, control response) is not something the worker did.
    if (line && !line.startsWith('{')) return line;
  }
  const installPrompt = process.context_data?.install_prompt;
  if (typeof installPrompt === 'string' && installPrompt.trim()) {
    return installPrompt.trim();
  }
  return process.name || 'Process started';
}

/**
 * A background run on one row: the standard status line (with its open-in-terminal button) and, under
 * it, one line saying what the worker is doing now — the last thing its trace reported.
 */
export function ProcessRunLine({
  process,
  onOpenInTerminal,
}: {
  process: AgenticProcess;
  onOpenInTerminal: () => void;
}) {
  const { events } = useFlowDataTrace(process);
  const statusLabel = runStatusLabel(process);
  const oneLiner = useMemo(() => runOneLiner(process, events), [events, process]);
  return (
    <div className="min-w-0 space-y-0.5">
      <ProcessStatusLine process={process} size="sm" onOpenInTerminal={onOpenInTerminal} className="min-w-0" />
      <div
        className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground"
        data-testid="process-run-line-one-liner"
      >
        <span className="font-medium text-foreground/80">{statusLabel}:</span> <span>{oneLiner}</span>
      </div>
    </div>
  );
}

/** The same line for a run known only by its id. */
export function ProcessRunLineById({ processId }: { processId: string }) {
  const { navigation } = useDockNavigation();
  const typeId = useMemo(() => {
    try {
      return new TypeId(AgenticProcess.type, processId);
    } catch {
      return null;
    }
  }, [processId]);
  const { data: process } = useEntity<AgenticProcess>(typeId, { enabled: !!typeId, watch: true });
  if (!process) return null;
  return <ProcessRunLine process={process} onOpenInTerminal={() => navigation.openDock(process.terminalDockPointer)} />;
}
