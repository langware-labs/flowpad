import { useMemo, useState } from 'react';
import { Activity, ExternalLink, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { AgenticProcess, ProcessKind, QueryFilter, QueryRequest, Skill } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { deriveAnalysisAction } from './analysis-state';
import { useSessionAnalyses } from './useSessionAnalyses';

/**
 * Transcript-toolbar controls for the agentic-process analysis (AgentTrace):
 * Run / Analyzing… / Open + Rerun / Refresh, plus the right-side execution
 * panel the analysis runs in. The analysis is an ANALYSIS-kind AgenticProcess
 * keyed to the analyzed process (child + mutual private context, paired
 * server-side at create).
 */
export function useAnalysisControls(
  sessionId: string | null,
  lastEntryTs: string | null,
  options: { analysisTargetOverride?: string | null } = {},
) {
  const { traces, analysisTarget, analysisProcesses } = useSessionAnalyses(sessionId, options);
  const [panelOpen, setPanelOpen] = useState(false);
  const [autoPrompt, setAutoPrompt] = useState<{ text: string; nonce: number; newSession?: boolean } | null>(null);

  const action = useMemo(
    () => deriveAnalysisAction({ traces, analysisProcesses, lastEntryTs }),
    [traces, analysisProcesses, lastEntryTs],
  );

  const startAnalysis = () => {
    if (!sessionId) return;
    setPanelOpen(true);
    // No URLs here — the worker resolves its own backend from the pinned
    // FLOW_INSTANCE (the skill's Environment section owns that).
    setAutoPrompt({
      text:
        `Use the agent-trace skill to analyze session ${sessionId} (worker type: claude) ` +
        `and produce the AgentTrace record.`,
      nonce: Date.now(),
      newSession: true, // every run is its own process → its own history entry
    });
  };

  return { action, panelOpen, setPanelOpen, autoPrompt, analysisTarget, startAnalysis };
}

export type AnalysisControls = ReturnType<typeof useAnalysisControls>;

export function AnalysisToolbarButtons({
  controls,
}: {
  controls: AnalysisControls;
}) {
  const { navigation } = useDockNavigation();
  const { action, startAnalysis, setPanelOpen } = controls;

  const btn =
    'flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground';

  const openNewest = () => {
    if (action.kind === 'open' || action.kind === 'refresh') {
      navigation.openDock(action.trace.editorDockPointer);
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-1" data-testid="transcript-analysis-controls">
        {action.kind === 'run' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={btn} onClick={startAnalysis} data-testid="analysis-run">
                <Activity className="h-3 w-3" />
                Run analysis
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Analyze this session: goals, issues, divergences and skill performance on a timeline
            </TooltipContent>
          </Tooltip>
        )}

        {action.kind === 'analyzing' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={btn} onClick={() => setPanelOpen(true)} data-testid="analysis-running">
                <Loader2 className="h-3 w-3 animate-spin" />
                Analyzing…
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Analysis is running — click to watch it in the side panel
            </TooltipContent>
          </Tooltip>
        )}

        {(action.kind === 'open' || action.kind === 'refresh') && (
          <>
            {action.kind === 'refresh' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className={btn} onClick={startAnalysis} data-testid="analysis-refresh">
                    <RefreshCw className="h-3 w-3" />
                    Refresh analysis
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  The session has new activity since the last analysis — run a fresh one (previous runs are kept)
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className={btn} onClick={openNewest} data-testid="analysis-open">
                  <ExternalLink className="h-3 w-3" />
                  Open analysis
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Open the latest analysis timeline ({action.runCount} run{action.runCount === 1 ? '' : 's'} for this session)
              </TooltipContent>
            </Tooltip>
            {action.kind === 'open' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className={btn} onClick={startAnalysis} data-testid="analysis-rerun">
                    <RotateCcw className="h-3 w-3" />
                    Rerun
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  Run a new analysis of this session — adds another entry, previous analyses are kept
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

/** Right-side drawer hosting the analysis run (generic execution panel). */
export function AnalysisSidePanel({
  controls,
}: {
  controls: AnalysisControls;
}) {
  const { panelOpen, setPanelOpen, analysisTarget, autoPrompt } = controls;

  // Resolve the agent-trace skill so freshly-created analysis processes get it
  // symlinked into their skills root regardless of workdir.
  const skillQuery = useMemo(
    () =>
      new QueryRequest({
        type: Skill.type,
        scope: [],
        name: 'skill:agent-trace',
        query: new QueryFilter({ match: { name: 'agent-trace' } }),
      }),
    [],
  );
  const { data: skills } = useEntitiesQuery<Skill>(skillQuery, { enabled: panelOpen });
  const skillPath = skills?.[0]?.asset_ref ?? null;

  if (!panelOpen || !analysisTarget) return null;

  return (
    <SideDrawer
      open={panelOpen}
      onOpenChange={setPanelOpen}
      title="Session analysis"
      width="w-[380px]"
      data-testid="analysis-side-panel"
    >
      <EntityExecutionPanel
        className="h-full"
        target={analysisTarget}
        processType={ProcessKind.Analysis}
        autoPrompt={autoPrompt}
        dense
        headerLabel={undefined}
        placeholder="Ask about this analysis…"
        emptyStateText="Run analysis to investigate this session."
        pastSessionsLabel="Past analyses"
        noPastSessionsLabel="No analyses yet"
        newSessionLabel="New analysis"
        historyLabel="Analysis history"
        onProcessCreated={async (p: AgenticProcess) => {
          if (skillPath) {
            try {
              await p.loadEmbeddedSkill(skillPath);
            } catch (err) {
              console.error('[AnalysisSidePanel] loadEmbeddedSkill failed', err);
            }
          }
        }}
      />
    </SideDrawer>
  );
}
