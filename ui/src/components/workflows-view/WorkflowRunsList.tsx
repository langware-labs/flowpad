import { Button } from '@src/components/ui/button';
import { ProcessStatusLine } from '@src/components/agentic-progress/shared/process-status-line';
import { useEntity } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { FolderOpen } from 'lucide-react';
import { AgenticProcess } from '@sdk';
import type { ProcessEntry } from './workflow-run-store';

interface WorkflowRunsListProps {
  entries: ProcessEntry[];
  currentEntry: ProcessEntry | null;
  computeNodeId: string | undefined;
}

export function WorkflowRunsList({ entries, currentEntry, computeNodeId }: WorkflowRunsListProps) {
  return (
    <div className="flex w-44 flex-shrink-0 flex-col border-l">
      <div className="flex h-[52px] flex-shrink-0 items-center border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">Runs</span>
        <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {entries.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {entries.map((entry, idx) => (
          <WorkflowRunItem
            key={entry.process.id}
            entry={entry}
            label={`Run ${entries.length - idx}`}
            isCurrent={currentEntry?.process.id === entry.process.id}
            computeNodeId={computeNodeId}
          />
        ))}
      </div>
    </div>
  );
}

function WorkflowRunItem({
  entry,
  label,
  isCurrent,
  computeNodeId,
}: {
  entry: ProcessEntry;
  label: string;
  isCurrent: boolean;
  computeNodeId: string | undefined;
}) {
  const { navigation } = useDockNavigation();
  // Watch the live entity so worker_status / visible / ready_for_input updates
  // propagate into the status line without the component keeping its own state.
  const { data: live } = useEntity<AgenticProcess>(entry.process.typeId ?? null);
  const process = live ?? entry.process;

  const handleOpenInTerminal = () => {
    navigation.openDock(process.dockPointer);
  };

  const handleOpenFolder = async () => {
    if (!computeNodeId || !process.workdir) return;
    try {
      await openExternalFromComputeNode(computeNodeId, process.workdir);
    } catch (err) {
      console.error('[WorkflowRunItem] Failed to open folder:', err);
    }
  };

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1.5 ${isCurrent ? 'bg-muted/50' : ''}`}
    >
      {/*
        One-liner: status icon + worker-status label ("Thinking" / "Using tool"
        / "Complete" …) + "Run N" secondary + Open-in-Terminal button gated on
        ready_for_input. The click navigates to /dock/shell/agentic_process-<id>;
        the loader flips visible=true → WorkerMode.Interactive on the fly.
      */}
      <ProcessStatusLine
        process={process}
        secondary={label}
        onOpenInTerminal={handleOpenInTerminal}
        size="sm"
        className="min-w-0 flex-1"
      />

      {process.workdir && computeNodeId && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 flex-shrink-0 opacity-0 group-hover:opacity-100"
          title="Open output folder"
          onClick={() => void handleOpenFolder()}
        >
          <FolderOpen className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
