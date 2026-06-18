import { useMemo, useState } from 'react';
import { AgentTrace, AgenticProcess, FSRef, TypeId } from '@sdk';
import { Loader2 } from 'lucide-react';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { WorkerIcon } from '@src/components/entity-execution-panel/history-row';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@src/components/ui/tabs';
import { formatDuration } from '@src/components/lens-viewer/shared/format-utils';
import { useEntity } from '@src/hooks/entity-hooks';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { CallTreeView } from './CallTreeView';
import { TraceDetailPanel } from './TraceDetailPanel';
import { TraceTimeline } from './TraceTimeline';
import { tsMs, type CallFrame } from './trace-types';
import { useAgentTraceDoc } from './useAgentTraceDoc';
import { useAgentTraceTab } from './use-agent-trace-tab';

interface AgentTraceAssetEditorProps {
  fsRef: FSRef;
  trace: AgentTrace;
}

function verdictStyle(verdict?: string | null): string {
  switch (verdict) {
    case 'ok':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'mixed':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'bad':
      return 'bg-red-500/10 text-red-600 dark:text-red-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function workerLabel(workerType?: string | null): string {
  switch (workerType) {
    case 'codex':
      return 'Codex';
    case 'copilot':
      return 'Copilot';
    case 'claude':
    case 'claude_code':
      return 'Claude';
    default:
      return workerType || 'Worker';
  }
}

/**
 * AgentTrace viewer: verdict banner (rendered from entity summary fields, so
 * "did it go well" shows before the multi-MB trace JSON loads), detail panel
 * in the middle, scrubbing timeline at the bottom.
 */
export function AgentTraceAssetEditor({ fsRef, trace }: AgentTraceAssetEditorProps) {
  const { doc, error, loading } = useAgentTraceDoc(fsRef);
  const { navigation } = useDockNavigation();
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<CallFrame | null>(null);
  const [tab, setTab] = useAgentTraceTab();
  const analyzedProcessTypeId = useMemo(() => {
    return trace.analyzed_process_id
      ? new TypeId(AgenticProcess.type, trace.analyzed_process_id)
      : null;
  }, [trace.analyzed_process_id]);
  const { data: analyzedProcess } = useEntity<AgenticProcess>(analyzedProcessTypeId, {
    enabled: !!analyzedProcessTypeId,
    watch: true,
  });
  const workerName = workerLabel(trace.worker_type);

  const startMs = useMemo(() => {
    if (!doc) return null;
    const stamps = doc.lanes.map((l) => tsMs(l.start_ts)).filter((v): v is number => v !== null);
    return stamps.length ? Math.min(...stamps) : null;
  }, [doc]);
  const effectiveCursor = cursorMs ?? startMs;

  // Click a call-tree frame → seek the timeline to it, highlight its lane, and
  // open the Details tab scoped to that frame.
  const handleSelectFrame = (frame: CallFrame) => {
    setSelectedFrame(frame);
    setSelectedLaneId(frame.lane_id);
    const ms = tsMs(frame.start_ts);
    if (ms !== null) setCursorMs(ms);
    setTab('details');
  };

  // Scrubbing the timeline returns to time-based detail (unpins the frame).
  const handleCursorChange = (ms: number) => {
    setCursorMs(ms);
    setSelectedFrame(null);
  };

  const handleOpenAnalyzedProcess = async () => {
    let process = analyzedProcess ?? null;

    if (!process && trace.analyzed_process_id) {
      process = await AgenticProcess.getById(trace.analyzed_process_id).catch(() => null);
    }
    if (!process && trace.session_id) {
      process = await AgenticProcess.getByWorkerId(trace.session_id, trace.worker_type).catch(() => null);
    }

    if (!process) {
      notify.error({
        title: 'Process not found',
        message: trace.session_id
          ? `No terminal process was found for session ${trace.session_id}.`
          : 'This trace is not linked to a worker session.',
      });
      return;
    }

    navigation.openDockPointer(process.terminalDockPointer);
  };

  const fileName = fsRef.path.split('/').pop() ?? 'trace.json';
  const dirPath = fsRef.path.slice(0, -fileName.length - 1);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-trace-editor">
      <AssetEditorHeader
        fileName={trace.name || fileName}
        dirPath={dirPath}
        actions={
          <button
            type="button"
            title={`Open ${workerName} terminal`}
            aria-label={`Open ${workerName} terminal`}
            data-testid="agent-trace-open-process"
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void handleOpenAnalyzedProcess()}
          >
            <WorkerIcon workerType={trace.worker_type} className="h-3.5 w-3.5 shrink-0" />
            <span>Open process</span>
          </button>
        }
      />

      <div
        className={cn('flex flex-shrink-0 items-baseline gap-2 px-3 py-2', verdictStyle(trace.verdict))}
        data-testid="agent-trace-verdict-banner"
      >
        <span className="text-sm font-semibold uppercase tracking-wide">
          {trace.verdict ?? 'unrated'}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{trace.verdict_reason ?? ''}</span>
        <span className="flex-shrink-0 text-xs opacity-80">
          {trace.issue_count} issues · {trace.divergence_count} divergences · {trace.lane_count}{' '}
          lanes · {trace.duration_ms ? formatDuration(trace.duration_ms) : '—'}
          {trace.cost_usd != null ? ` · $${trace.cost_usd.toFixed(2)}` : ''}
        </span>
      </div>

      {error ? (
        <div className="flex flex-1 items-center justify-center text-sm text-destructive">
          Failed to load trace: {error}
        </div>
      ) : loading || !doc || effectiveCursor === null ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading trace…
        </div>
      ) : (
        <>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as 'stack' | 'details')}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="mx-3 mt-2 h-8 self-start">
              <TabsTrigger value="stack" className="py-0.5 text-xs">
                Transcript call stack
              </TabsTrigger>
              <TabsTrigger value="details" className="py-0.5 text-xs">
                Details
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="stack"
              forceMount
              className="mt-1 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            >
              <CallTreeView
                doc={doc}
                selectedFrameId={selectedFrame?.id ?? null}
                onSelectFrame={handleSelectFrame}
              />
            </TabsContent>
            <TabsContent
              value="details"
              forceMount
              className="mt-1 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
            >
              <TraceDetailPanel
                doc={doc}
                cursorMs={effectiveCursor}
                selectedLaneId={selectedLaneId}
                selectedFrame={selectedFrame}
              />
            </TabsContent>
          </Tabs>
          <TraceTimeline
            doc={doc}
            cursorMs={effectiveCursor}
            onCursorChange={handleCursorChange}
            selectedLaneId={selectedLaneId}
            onSelectLane={setSelectedLaneId}
          />
        </>
      )}
    </div>
  );
}
