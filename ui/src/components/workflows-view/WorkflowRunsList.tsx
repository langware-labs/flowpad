import { Button } from '@src/components/ui/button';
import { StatusIndicator } from '@src/components/agentic-progress/shared/status-indicator';
import { useProcessState } from '@src/hooks/use-process-state';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { FolderOpen, Terminal } from 'lucide-react';
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
  const state = useProcessState(entry.process);

  const handleOpenSession = () => {
    navigation.openDock(entry.process.dockPointer);
  };

  const handleOpenFolder = async () => {
    if (!computeNodeId || !entry.process.workdir) return;
    try {
      await openExternalFromComputeNode(computeNodeId, entry.process.workdir);
    } catch (err) {
      console.error('[WorkflowRunItem] Failed to open folder:', err);
    }
  };

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1.5 ${isCurrent ? 'bg-muted/50' : ''}`}
    >
      {/* Status indicator — reuses the canonical config from status-indicator.tsx. */}
      <StatusIndicator status={state.status} size="sm" className="flex-shrink-0" />

      {/* Label */}
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>

      {/* Actions */}
      <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          title="Open Claude session"
          onClick={handleOpenSession}
        >
          <Terminal className="h-3 w-3" />
        </Button>
        {entry.process.workdir && computeNodeId && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            title="Open output folder"
            onClick={() => void handleOpenFolder()}
          >
            <FolderOpen className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
