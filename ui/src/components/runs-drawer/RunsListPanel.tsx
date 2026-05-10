import { AgenticProcess, Run, RunStatus, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Button } from '@src/components/ui/button';
import { Loader2, CheckCircle2, AlertTriangle, Terminal } from 'lucide-react';

/** Truncate a prompt to ~40 chars on a word boundary, with ellipsis. */
function truncatePrompt(text: string, max = 40): string {
  const trimmed = (text ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 10 ? cut.slice(0, lastSpace) : cut}…`;
}

interface RunsListPanelProps {
  runs: Run[];
}

/**
 * One row per Run (= one Approve & Execute). Status reflects the Run, not
 * the underlying AgenticProcess — multiple Runs can point at the same
 * process, and clicking the terminal icon on any of them attaches to that
 * shared session.
 */
export function RunsListPanel({ runs }: RunsListPanelProps) {
  // Newest-first; fall back to id ordering when started_at is missing so the
  // list stays deterministic during the brief moment before the timestamp is
  // populated by the server.
  const ordered = [...runs].sort((a, b) => {
    const ta = a.started_at ?? '';
    const tb = b.started_at ?? '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return (b.id ?? '').localeCompare(a.id ?? '');
  });

  return (
    <div className="h-full overflow-y-auto py-1" data-testid="runs-list-panel">
      {ordered.length === 0 && (
        <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
          No runs yet.
        </div>
      )}
      {ordered.map((run, idx) => (
        <RunItem key={run.id} run={run} label={`Run ${ordered.length - idx}`} />
      ))}
    </div>
  );
}

function RunItem({ run, label }: { run: Run; label: string }) {
  const { navigation } = useDockNavigation();
  // Live subscription to this Run's entity-event updates. The parent query
  // (`useEntitiesQuery`) sees CREATEs reliably but the UPDATEs that flip
  // status from running → stopped don't always re-render the row through it,
  // so each row owns its own subscription — same pattern WorkflowRunsPanel
  // uses for the AgenticProcess entry.
  const { data: liveRun } = useEntity<Run>(run.id ? new TypeId(Run.type, run.id) : null);
  const current = liveRun ?? run;
  const processTypeId = current.process_id ? new TypeId(AgenticProcess.type, current.process_id) : null;
  const { data: process } = useEntity<AgenticProcess>(processTypeId);

  const promptPreview = truncatePrompt(current.prompt_text ?? '') || label;
  const status = (current.status ?? RunStatus.RUNNING) as string;
  // Block "Open in terminal" while the run is in flight: the underlying
  // AgenticProcess is still ``visible: false`` (headless), and the terminal
  // tab list filters by ``visible: true`` — clicking now navigates to a
  // pointer the tab strip can't render until the run finishes and the user
  // refreshes. Re-enable on terminal statuses.
  const isRunning = status === RunStatus.RUNNING;

  const onOpenTerminal = () => {
    if (isRunning) return;
    if (process?.terminalDockPointer) navigation.openDock(process.terminalDockPointer);
  };

  const terminalTitle = isRunning
    ? 'Available after the run completes'
    : process
      ? 'Open in terminal'
      : 'Process not available';

  return (
    <div className="group flex items-center gap-2 px-2 py-1.5">
      <StatusIcon status={status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground" title={current.prompt_text ?? ''}>
          {promptPreview}
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label} · {status}</div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 flex-shrink-0 opacity-60 group-hover:opacity-100 disabled:opacity-30"
        title={terminalTitle}
        disabled={isRunning || !process?.dockPointer}
        onClick={onOpenTerminal}
      >
        <Terminal className="h-3 w-3" />
      </Button>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === RunStatus.RUNNING) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  }
  if (status === RunStatus.FAILED) {
    return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
  }
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
}
