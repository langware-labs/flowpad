import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { AgentTrace, AgenticProcess, FSRef, TypeId } from '@sdk';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { WorkerIcon } from '@src/components/entity-execution-panel/history-row';
import { useEntity } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { CallStackView } from '@src/components/lens-viewer/shared/transcript-features/CallStackView';
import { workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@src/components/ui/tabs';
import { useIsAdvanced } from '@src/components/view-mode';
import type { WorkerType } from '@src/hooks/use-transcript';
import { useAgentTraceDoc } from './useAgentTraceDoc';
import { SimpleSessionReport } from './simple/SimpleSessionReport';

interface AgentTraceAssetEditorProps {
  fsRef: FSRef;
  trace: AgentTrace;
}

/** The trace-skeleton endpoint keys on the bare worker name. */
function normalizeWorker(workerType?: string | null): WorkerType {
  return (workerType === 'claude_code' ? 'claude' : workerType || 'claude') as WorkerType;
}

/**
 * AgentTrace viewer: shows **only** the Call-stack view, via component-level
 * reuse of {@link CallStackView} (the same outline timeline as the transcript
 * lens — legend, zoom, chips, the advanced `agent errors` lane). The saved
 * trace's analysis findings are overlaid as the standard `skill issues` lane
 * (optional input). The structural base is the fresh skeleton for the session.
 */
export function AgentTraceAssetEditor({ fsRef, trace }: AgentTraceAssetEditorProps) {
  const { t } = useLingui();
  const { doc } = useAgentTraceDoc(fsRef);
  const { navigation } = useDockNavigation();
  const advanced = useIsAdvanced();
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

  // Asset-editor host owns zoom (the transcript-dock zoom hook can't safely
  // patch this dock's pointer). Local state: drag/chips/reset work per session.
  const [zoom, setZoom] = useState<[number, number] | null>(null);

  // Skill issues = the saved analysis's divergences + issues, overlaid as the
  // standard lane. Optional — absent until the (possibly large) JSON resolves.
  const skillIssues = useMemo(
    () => (doc ? [...(doc.annotations?.divergences ?? []), ...(doc.annotations?.issues ?? [])] : undefined),
    [doc],
  );

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
        title: t`Process not found`,
        message: trace.session_id
          ? t`No terminal process was found for session ${trace.session_id}.`
          : t`This trace is not linked to a worker session.`,
      });
      return;
    }

    navigation.openDockPointer(process.terminalDockPointer);
  };

  const fileName = fsRef.path.split('/').pop() ?? 'trace.json';
  const dirPath = fsRef.path.slice(0, -fileName.length - 1);

  // Header reads "SubAgent analysis: <the analyzed process's name>" — the watched
  // process load above makes this reliable even when the row wasn't cached.
  // Falls back to the raw trace name until that name resolves.
  const processName = analyzedProcess?.displayName?.trim();
  const headerTitle = processName ? `SubAgent analysis: ${processName}` : trace.name || fileName;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-trace-editor">
      <AssetEditorHeader
        fileName={headerTitle}
        dirPath={dirPath}
        actions={
          <button
            type="button"
            title={t`Open ${workerName} terminal`}
            aria-label={t`Open ${workerName} terminal`}
            data-testid="agent-trace-open-process"
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void handleOpenAnalyzedProcess()}
          >
            <WorkerIcon workerType={trace.worker_type} className="h-3.5 w-3.5 shrink-0" />
            <span><Trans>Open process</Trans></span>
          </button>
        }
      />

      {/* Non-technical users get the plain-language report only. The dense
          developer timeline (CallStackView) is gated behind Advanced mode, via a
          Summary | Timeline toggle that defaults to Summary. */}
      {!advanced ? (
        <SimpleSessionReport trace={trace} doc={doc} />
      ) : (
        <Tabs defaultValue="summary" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-3 mt-2 h-8 self-start">
            <TabsTrigger value="summary" className="py-0.5 text-xs">
              <Trans>Summary</Trans>
            </TabsTrigger>
            <TabsTrigger value="timeline" className="py-0.5 text-xs">
              <Trans>Timeline</Trans>
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="summary"
            className="mt-1 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <SimpleSessionReport trace={trace} doc={doc} />
          </TabsContent>
          <TabsContent
            value="timeline"
            forceMount
            className="mt-1 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <CallStackView
              workerType={normalizeWorker(trace.worker_type)}
              sessionId={trace.session_id}
              skillIssues={skillIssues}
              zoom={zoom}
              onZoomChange={setZoom}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
