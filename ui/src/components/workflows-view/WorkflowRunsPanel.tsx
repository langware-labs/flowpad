import { Button } from '@src/components/ui/button';
import { ProcessStatusLine } from '@src/components/agentic-progress/shared/process-status-line';
import { useEntity } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FolderOpen } from 'lucide-react';
import { AgenticProcess } from '@sdk';
import type { ProcessEntry } from './workflow-run-store';

interface WorkflowRunsPanelProps {
  entries: ProcessEntry[];
  currentEntry: ProcessEntry | null;
  computeNodeId: string | undefined;
}

/**
 * Scrollable list of workflow runs. Renders as a plain content block — no
 * drawer chrome — so it can be dropped into any container (today: a tab panel
 * inside the markdown side drawer).
 */
export function WorkflowRunsPanel({ entries, currentEntry, computeNodeId }: WorkflowRunsPanelProps) {
  return (
    <div className="h-full overflow-y-auto py-1" data-testid="workflow-runs-panel">
      {entries.length === 0 && (
        <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
          No runs yet.
        </div>
      )}
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
  const { data: live } = useEntity<AgenticProcess>(entry.process.typeId ?? null);
  const process = live ?? entry.process;

  const handleOpenInTerminal = () => {
    navigation.openDock(process.dockPointer);
  };

  const handleOpenFolder = async () => {
    if (!process.output_folder) return;
    try {
      await process.output_folder.open();
    } catch (err) {
      console.error('[WorkflowRunItem] Failed to open output folder:', err);
    }
  };

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1.5 ${isCurrent ? 'bg-muted/50' : ''}`}
    >
      <ProcessStatusLine
        process={process}
        secondary={label}
        onOpenInTerminal={handleOpenInTerminal}
        size="sm"
        className="min-w-0 flex-1"
      />

      {process.output_folder && (
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
