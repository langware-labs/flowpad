import { Button } from '@src/components/ui/button';
import { ProcessStatusLine } from '@src/components/agentic-progress/shared/process-status-line';
import { useEntity } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FolderOpen } from 'lucide-react';
import { AgenticProcess } from '@sdk';
import type { ProcessEntry } from './workflow-run-store';

/** Truncate a prompt to ~40 chars on a word boundary, with ellipsis. */
function truncatePrompt(text: string, max = 40): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 10 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Prefer the prompt that drove the run; fall back to "Run N". */
function runLabel(entry: ProcessEntry, n: number): string {
  const prompt = (entry.process.cli_config as Record<string, unknown> | undefined)?.last_prompt;
  if (typeof prompt === 'string' && prompt.trim()) return truncatePrompt(prompt);
  return `Run ${n}`;
}

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
          label={runLabel(entry, entries.length - idx)}
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
          className="h-5 w-5 flex-shrink-0"
          title="Open output folder"
          onClick={() => void handleOpenFolder()}
        >
          <FolderOpen className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
