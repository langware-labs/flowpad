import { useMemo } from 'react';
import { AgentTrace, AgenticProcess, FSRef, TypeId } from '@sdk';
import { Loader2 } from 'lucide-react';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { WorkerIcon } from '@src/components/entity-execution-panel/history-row';
import { useEntity } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useSkillsByName } from '@src/hooks/useSkillsByName';
import { launchSkillEval } from '@src/components/assets/editor/skill/skill-eval-analysis';
import { notify } from '@src/notifications';
import { AgentTraceView, VerdictBanner, type VerdictBannerData } from './AgentTraceView';
import { useAgentTraceDoc } from './useAgentTraceDoc';

interface AgentTraceAssetEditorProps {
  fsRef: FSRef;
  trace: AgentTrace;
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
 * "did it go well" shows before the multi-MB trace JSON loads), call-stack /
 * details tabs, and a scrubbing timeline. The body is shared with the
 * transcript lens's "Call stack" view via {@link AgentTraceView}.
 */
export function AgentTraceAssetEditor({ fsRef, trace }: AgentTraceAssetEditorProps) {
  const { doc, error, loading } = useAgentTraceDoc(fsRef);
  const { navigation } = useDockNavigation();
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
  const { byName } = useSkillsByName();

  // In-trace "Eval" on a skill frame → launch a skillit analysis keyed to that
  // skill, with this run as context. The analysis surfaces in the skill editor's
  // eval side panel (both key to the skill's TypeId).
  const handleEvaluateSkill = (skillName: string) => {
    const targetSkill = byName.get(skillName);
    if (!targetSkill) {
      notify.error({ title: 'Skill not found', message: `No skill named "${skillName}".` });
      return;
    }
    void launchSkillEval({
      targetSkill,
      sourceProcessId: trace.analyzed_process_id,
      sessionId: trace.session_id,
    });
    notify.success({ title: `Evaluating "${skillName}"…` });
  };

  // Entity summary drives the banner before (and during) the JSON load, so the
  // verdict is visible immediately and doesn't flicker when the doc resolves.
  const bannerData: VerdictBannerData = {
    verdict: trace.verdict,
    verdict_reason: trace.verdict_reason,
    issue_count: trace.issue_count,
    divergence_count: trace.divergence_count,
    lane_count: trace.lane_count,
    duration_ms: trace.duration_ms,
    cost_usd: trace.cost_usd,
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

      {error ? (
        <>
          <VerdictBanner data={bannerData} />
          <div className="flex flex-1 items-center justify-center text-sm text-destructive">
            Failed to load trace: {error}
          </div>
        </>
      ) : loading || !doc ? (
        <>
          <VerdictBanner data={bannerData} />
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading trace…
          </div>
        </>
      ) : (
        <AgentTraceView doc={doc} banner={bannerData} onEvaluateSkill={handleEvaluateSkill} />
      )}
    </div>
  );
}
