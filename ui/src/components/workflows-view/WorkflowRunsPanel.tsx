import { Button } from '@src/components/ui/button';
import { ProcessStatusLine } from '@src/components/agentic-progress/shared/process-status-line';
import { useEntity } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { FileText, FolderOpen } from 'lucide-react';
import { AgenticProcess } from '@sdk';
import type { ProcessEntry } from './workflow-run-store';

/**
 * Claude / Codex name workspace dirs by replacing every non-alphanumeric
 * char with `-` (so `/Users/alice/.claude/worktrees/foo` becomes
 * `-Users-alice--claude-worktrees-foo`). Mirrors Claude's own dirname rule
 * for `~/.claude/projects/<projectEncodedName>/<sessionId>.jsonl`.
 */
function workdirToProjectEncodedName(workdir: string): string {
  return workdir.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Build the transcript-lens DockPointer for a process, or `null` if we don't
 * have enough information yet (no session_id, no workdir, or unsupported
 * worker). Codex transcripts key on the rollout JSONL absolute path which
 * `AgenticProcess` doesn't expose directly today, so we surface only Claude
 * for now and fall back gracefully.
 */
function transcriptPointerForProcess(process: AgenticProcess): DockPointer | null {
  const sessionId = process.session_id;
  const workdir = process.workdir;
  if (!sessionId || !workdir) return null;
  const worker = (process.worker_type ?? 'claude_code').toString();
  if (!worker.startsWith('claude')) return null;
  const ref = `${workdirToProjectEncodedName(workdir)}/${sessionId}`;
  return DockPointer.forLensTranscript('claude', ref);
}

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
  /** Called when a row is clicked. Receives the process id. */
  onSelectRun?: (processId: string) => void;
}

/**
 * Scrollable list of workflow runs. Renders as a plain content block — no
 * drawer chrome — so it can be dropped into any container (today: a tab panel
 * inside the markdown side drawer).
 */
export function WorkflowRunsPanel({
  entries,
  currentEntry,
  computeNodeId,
  onSelectRun,
}: WorkflowRunsPanelProps) {
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
          onSelectRun={onSelectRun}
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
  onSelectRun,
}: {
  entry: ProcessEntry;
  label: string;
  isCurrent: boolean;
  computeNodeId: string | undefined;
  onSelectRun?: (processId: string) => void;
}) {
  const { navigation } = useDockNavigation();
  const { data: live } = useEntity<AgenticProcess>(entry.process.typeId ?? null);
  const process = live ?? entry.process;
  // [AP-status-debug] DELETE ME — fires on every re-render of the row so we can
  // see what the UI is actually pulling out of the cache + which path the row
  // is on (live entity from useEntity vs stale entry.process fallback).
  console.log('[AP-status-debug] WorkflowRunItem render', {
    id: process.id,
    fromLive: !!live,
    status: process.status,
    workerStatus: process.workerStatus,
  });

  const handleOpenInTerminal = () => {
    navigation.openDock(process.terminalDockPointer);
  };

  const handleOpenFolder = async () => {
    if (!process.output_folder) return;
    try {
      await process.output_folder.open();
    } catch (err) {
      console.error('[WorkflowRunItem] Failed to open output folder:', err);
    }
  };

  const transcriptPointer = transcriptPointerForProcess(process);

  // Whole-row click opens the trace viewer. Inner buttons stop propagation
  // so they keep working independently.
  const handleRowClick = onSelectRun
    ? () => onSelectRun(process.id)
    : undefined;

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1.5 ${
        isCurrent ? 'bg-muted/50' : ''
      } ${handleRowClick ? 'cursor-pointer hover:bg-muted/40' : ''}`}
      onClick={handleRowClick}
      role={handleRowClick ? 'button' : undefined}
      tabIndex={handleRowClick ? 0 : undefined}
      onKeyDown={
        handleRowClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleRowClick();
              }
            }
          : undefined
      }
      data-testid="workflow-run-row"
    >
      <ProcessStatusLine
        process={process}
        secondary={label}
        onOpenInTerminal={() => {
          handleOpenInTerminal();
        }}
        size="sm"
        className="min-w-0 flex-1"
      />

      {transcriptPointer && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 flex-shrink-0"
          title="Open transcript"
          onClick={(e) => {
            e.stopPropagation();
            navigation.openDock(transcriptPointer);
          }}
          data-testid="run-row-open-transcript"
        >
          <FileText className="h-3 w-3" />
        </Button>
      )}

      {process.output_folder && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 flex-shrink-0"
          title="Open output folder"
          onClick={(e) => {
            e.stopPropagation();
            void handleOpenFolder();
          }}
        >
          <FolderOpen className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
