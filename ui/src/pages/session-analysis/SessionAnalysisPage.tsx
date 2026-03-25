import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { useWorkflowProgressInfo } from '@src/components/live-workflow/hooks/useWorkflowProgressInfo';
import { useAnalysisSessions } from '@src/hooks/use-analysis-sessions';
import { useProcessState } from '@src/hooks/use-process-state';
import { useResources, SystemResourceType } from '@src/hooks/use-resources';
import {
  AgenticProcess,
  ProcessorStatus,
  ProcessResult,
  dataContext,
  fsManager,
} from '@sdk';
import type { ClaudeSessionRecordData } from '@sdk/resource_management/fs_records/claude/claude-session';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useToast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FilePenLine, FolderOpen, Info, ListTodo, Play, Route, Terminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const WORKDIR_TEMPLATE_SUFFIX = '.flow/sessions/{process_id}';

function normalizeAbsPath(path: string): string {
  if (!path) return path;
  return path.startsWith('/') ? path : `/${path}`;
}

function buildResultUname(sessionId: string): string {
  const raw = `${sessionId}_analysis`;
  const normalized = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+/, '');
  if (normalized && /^[a-zA-Z]/.test(normalized)) {
    return normalized;
  }
  return `session_${normalized || 'analysis'}`;
}

function getSessionKey(session: ClaudeSessionRecordData): string {
  return session.id || session.name || '';
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-';
  if (value < 1000) return value.toString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 1)}M`;
  return `${(value / 1_000_000_000).toFixed(value >= 100_000_000_000 ? 0 : 1)}B`;
}

function getSessionTooltipInfo(session: ClaudeSessionRecordData): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (session.id) rows.push(['ID', session.id]);
  if (session.name) rows.push(['Name', session.name]);
  if (session.project_encoded_name) rows.push(['Project', session.project_encoded_name]);
  if (session.cwd) rows.push(['CWD', session.cwd]);
  const transcriptPath = session.jsonl_path || session.path;
  if (transcriptPath) rows.push(['Path', transcriptPath]);
  if (session.created_at) rows.push(['Created', new Date(session.created_at).toLocaleString()]);
  if (session.modified_at) rows.push(['Modified', new Date(session.modified_at).toLocaleString()]);
  return rows;
}

function formatTimeAgo(isoDate?: string | null): string {
  if (!isoDate) return '';
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return 'just now';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < hour) {
    const minutes = Math.max(1, Math.round(diffMs / minute));
    return `${minutes}m ago`;
  }
  if (diffMs < day) {
    const hours = Math.max(1, Math.round(diffMs / hour));
    return `${hours}h ago`;
  }
  const days = Math.max(1, Math.round(diffMs / day));
  return `${days}d ago`;
}

function formatDuration(startIso?: string | null, endIso?: string | null): string {
  if (!startIso || !endIso) return '';
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  const diffMs = end - start;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < hour) {
    const minutes = Math.max(1, Math.round(diffMs / minute));
    return `${minutes}m`;
  }
  if (diffMs < day) {
    const hours = Math.max(1, Math.round(diffMs / hour));
    return `${hours}h`;
  }
  const days = Math.max(1, Math.round(diffMs / day));
  return `${days}d`;
}

export function SessionAnalysisPage() {
  const { computeNode } = useAgentContext();
  const { navigation } = useDockNavigation();
  const { toast } = useToast();
  const [showFlowpadSessions, setShowFlowpadSessions] = useState(false);
  const [showAgentSessions, setShowAgentSessions] = useState(false);

  const { items: sessions, isLoading: sessionsLoading } = useResources<ClaudeSessionRecordData>(SystemResourceType.SESSION, {
    limit: 50,
  });
  const { items: analyses, isLoading: analysesLoading, refresh: refreshAnalyses } = useAnalysisSessions({ limit: 50 });

  const [activeProcess, setActiveProcess] = useState<AgenticProcess | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const { state: processState } = useProcessState(activeProcess);
  const isRunning =
    processState.status === ProcessorStatus.RUNNING ||
    processState.status === ProcessorStatus.STEPPING ||
    processState.status === ProcessorStatus.PAUSED;
  const { statusMessage, activityLabel, elapsedTime } = useWorkflowProgressInfo(activeProcess, isRunning);

  const paths = dataContext.bootstrapInfo?.desktop_info?.paths;

  const recentSessions = useMemo(() => {
    const filtered = sessions.filter((session) => {
      const sessionName = (session.name || session.id || '').toLowerCase();
      const path = `${session.jsonl_path || session.path || ''} ${session.cwd || ''}`.toLowerCase();
      const isAgentSession = sessionName.includes('agent');
      const isFlowpadPath = path.includes('.flow/sessions') || path.includes('.flow\\sessions');
      if (!showAgentSessions && isAgentSession) return false;
      if (!showFlowpadSessions && isFlowpadPath) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      const aTime = a.modified_at || a.created_at || '';
      const bTime = b.modified_at || b.created_at || '';
      return aTime < bTime ? 1 : -1;
    });
    return sorted.slice(0, 10);
  }, [sessions, showFlowpadSessions, showAgentSessions]);

  const analysisBySessionId = useMemo(() => {
    const map = new Map<string, ProcessResult>();
    for (const analysis of analyses) {
      if (!analysis.source_session_id) continue;
      const existing = map.get(analysis.source_session_id);
      const existingTime = existing?.updated_date ? new Date(existing.updated_date).getTime() : 0;
      const nextTime = analysis.updated_date ? new Date(analysis.updated_date).getTime() : 0;
      if (!existing || nextTime > existingTime) {
        map.set(analysis.source_session_id, analysis);
      }
    }
    return map;
  }, [analyses]);

  const analysisByUname = useMemo(() => {
    const map = new Map<string, ProcessResult>();
    for (const analysis of analyses) {
      const uname = analysis.uname ?? (analysis.id && analysis.id.startsWith('@') ? analysis.id.slice(1) : null);
      if (!uname) continue;
      map.set(uname, analysis);
    }
    return map;
  }, [analyses]);

  const handleOpenAnalysisEditor = useCallback(
    (analysis: ProcessResult) => {
      if (!computeNode?.typeId) {
        toast({ title: 'Compute node unavailable', description: 'No compute node is available.' });
        return;
      }
      if (!analysis.root_vfs_path) {
        toast({ title: 'Analysis not found', description: 'No analysis report path is available.' });
        return;
      }
      try {
        const reportPath = `${analysis.root_vfs_path.replace(/\/$/, '')}/analysis.md`;
        navigation.openDock(DockPointer.forFile(reportPath));
      } catch (error) {
        console.error('[SessionAnalysisPage] Failed to open analysis editor:', error);
        toast({ title: 'Failed to open analysis', description: 'Could not open the analysis report.' });
      }
    },
    [computeNode?.typeId, navigation, toast],
  );

  const handleOpenAnalysisFolder = useCallback(
    (analysis: ProcessResult) => {
      if (!computeNode?.typeId) {
        toast({ title: 'Compute node unavailable', description: 'No compute node is available.' });
        return;
      }
      if (!analysis.root_vfs_path) {
        toast({ title: 'Analysis not found', description: 'No analysis report path is available.' });
        return;
      }
      try {
        navigation.openDock(DockPointer.forExplorer(analysis.root_vfs_path));
      } catch (error) {
        console.error('[SessionAnalysisPage] Failed to open analysis folder:', error);
        toast({ title: 'Failed to open folder', description: 'Could not open the analysis folder.' });
      }
    },
    [computeNode?.typeId, navigation, toast],
  );

  const handleRunAnalysis = useCallback(
    async (session: ClaudeSessionRecordData) => {
      if (!computeNode?.typeId) {
        toast({ title: 'Compute node unavailable', description: 'No compute node is available.' });
        return;
      }
      if (!paths?.home) {
        toast({ title: 'Missing paths', description: 'Home path is unavailable.' });
        return;
      }
      const sessionTranscriptPath = session.jsonl_path || session.path;
      if (!sessionTranscriptPath) {
        toast({ title: 'Session path missing', description: 'Cannot locate transcript for this session.' });
        return;
      }

      try {
        const workdirTemplate = `${normalizeAbsPath(paths.home)}/${WORKDIR_TEMPLATE_SUFFIX}`;
        const processor = await computeNode.createAgenticProcessor();
        const normalizedSessionId = getSessionKey(session);
        const resultUname = buildResultUname(normalizedSessionId);
        const process = await processor.createProcess(
          {
            workdir: workdirTemplate,
            permissionMode: 'bypassPermissions',
          },
          {
            result: {
              uname: resultUname,
              resultType: 'analysis',
              sourceSessionId: normalizedSessionId,
            },
          },
        );

        try {
          const earlyResult = await ProcessResult.getById(`@${resultUname}`);
          if (earlyResult) {
            earlyResult.status = 'running';
            earlyResult.worker_session_id = process.worker_session_id ?? earlyResult.worker_session_id;
            await earlyResult.save();
          }
        } catch (error) {
          console.error('[SessionAnalysisPage] Failed to persist running analysis:', error);
        }

        await refreshAnalyses();

        const resolvedWorkdir = workdirTemplate.replace('{process_id}', process.id);
        await fsManager.mkdir(computeNode.typeId, resolvedWorkdir);
        const analysisPathAbs = `${resolvedWorkdir}/analysis.md`;

        await process.watch();

        const instruction = [
          `Analyze the session transcript at ${sessionTranscriptPath}.`,
          `Write the report to ${analysisPathAbs}.`,
        ].join('\n');
        await process.executeInstruction(instruction, { sync: false });

        setActiveProcess(process);
        setActiveSessionId(normalizedSessionId);

        const persistResultState = async (status: 'running' | 'complete' | 'error') => {
          try {
            const result = await ProcessResult.getById(`@${resultUname}`);
            if (!result) {
              return;
            }
            result.status = status;
            result.worker_session_id = process.worker_session_id ?? result.worker_session_id;
            await result.save();
            await refreshAnalyses();
          } catch (error) {
            console.error('[SessionAnalysisPage] Failed to update analysis status:', error);
          }
        };

        await persistResultState('running');

        const updateStatus = async (status: 'complete' | 'error') => {
          await persistResultState(status);
        };

        const syncWorkerSession = async () => {
          for (let attempt = 0; attempt < 10; attempt += 1) {
            if (process.worker_session_id) {
              await persistResultState('running');
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        };
        void syncWorkerSession();

        process.on('complete', () => {
          void updateStatus('complete');
        });
        process.on('error', () => {
          void updateStatus('error');
        });
      } catch (error) {
        console.error('[SessionAnalysisPage] Failed to run analysis:', error);
        toast({ title: 'Analysis failed', description: 'Could not start the analysis run.' });
      }
    },
    [computeNode, paths?.home, refreshAnalyses, toast],
  );

  const handleOpenTranscript = useCallback(
    (session: ClaudeSessionRecordData) => {
      if (!session.project_encoded_name) {
        toast({ title: 'Transcript unavailable', description: 'No project info found for this session.' });
        return;
      }
      navigation.openLens('claude', 'transcript', `${session.project_encoded_name}/${session.id}`);
    },
    [navigation, toast],
  );

  const handleOpenTodos = useCallback(
    (session: ClaudeSessionRecordData) => {
      if (session.project_encoded_name) {
        navigation.openSystemProfile('todos', undefined, {
          scope: 'project',
          project: session.project_encoded_name,
        });
        return;
      }
      navigation.openSystemProfile('todos');
    },
    [navigation],
  );

  const handleOpenWorkerSession = useCallback(
    async (sessionId: string | null | undefined) => {
      if (!sessionId) {
        toast({ title: 'Session unavailable', description: 'No worker session is available yet.' });
        return;
      }
      if (!computeNode) {
        toast({ title: 'Compute node unavailable', description: 'No compute node is available.' });
        return;
      }

      try {
        // Map worker session ID to process ID via upsertSessionProcess
        const { processId: agenticProcessId } = await computeNode.upsertSessionProcess(sessionId, {});
        void navigation.openShellProcess(agenticProcessId);
      } catch (error) {
        console.error('[SessionAnalysisPage] Failed to open worker session:', error);
        toast({
          title: 'Failed to open session',
          description: `Could not open the worker session: ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'destructive',
        });
      }
    },
    [navigation, toast, computeNode],
  );

  useEffect(() => {
    if (activeProcess) return;
    const running = analyses.find((item) => item.status === 'running' && item.process_id);
    if (!running?.process_id) return;
    let cancelled = false;
    const attachProcess = async () => {
      try {
        const process = await AgenticProcess.getByIdWithHistory(running.process_id!);
        if (!process || cancelled) return;
        setActiveProcess(process);
        if (running.source_session_id) {
          setActiveSessionId(running.source_session_id);
        }
        const isActiveStatus = [ProcessorStatus.RUNNING, ProcessorStatus.STEPPING, ProcessorStatus.PAUSED].includes(
          process.state.status,
        );
        if (!isActiveStatus && running.status === 'running') {
          try {
            running.status = 'complete';
            if (process.worker_session_id) {
              running.worker_session_id = process.worker_session_id;
            }
            await running.save();
            await refreshAnalyses();
          } catch (error) {
            console.error('[SessionAnalysisPage] Failed to finalize analysis status:', error);
          }
        }
      } catch (error) {
        console.error('[SessionAnalysisPage] Failed to reattach process:', error);
      }
    };
    void attachProcess();
    return () => {
      cancelled = true;
    };
  }, [activeProcess, analyses]);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Analyze Recent Activity</h2>
          <p className="text-xs text-muted-foreground">Review your last 10 sessions and run analysis reports.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3 accent-primary"
              checked={showAgentSessions}
              onChange={(event) => setShowAgentSessions(event.target.checked)}
            />
            Show agent sessions
          </label>
          <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3 accent-primary"
              checked={showFlowpadSessions}
              onChange={(event) => setShowFlowpadSessions(event.target.checked)}
            />
            Show flowpad sessions
          </label>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          Recent Sessions
        </div>

        <div className="grid grid-cols-[120px_1.2fr_1.6fr_90px_80px_100px_190px] gap-2 border-b border-border px-3 py-2 text-[10px] font-medium text-muted-foreground">
          <span>Last Activity</span>
          <span>Session ID</span>
          <span>CWD</span>
          <span>Messages</span>
          <span>Tokens</span>
          <span>Cost</span>
          <span>Actions</span>
        </div>

        <div className="max-h-[60vh] overflow-auto">
          {sessionsLoading ? (
            <div className="px-3 py-6 text-xs text-muted-foreground">Loading sessions...</div>
          ) : recentSessions.length === 0 ? (
            <div className="px-3 py-6 text-xs text-muted-foreground">No sessions found.</div>
          ) : (
            recentSessions.map((session) => {
              const normalizedSessionId = getSessionKey(session);
              const tokenParts = [
                session.input_tokens,
                session.output_tokens,
                session.cache_read_input_tokens,
                session.cache_creation_input_tokens,
              ];
              const hasTokenData = tokenParts.some((value) => typeof value === 'number');
              const totalTokens = hasTokenData ? tokenParts.reduce((sum, value) => sum + (value || 0), 0) : null;
              const uname = buildResultUname(normalizedSessionId);
              const analysisMatch = analysisBySessionId.get(normalizedSessionId) ?? analysisByUname.get(uname);
              const canOpen = analysisMatch?.status === 'complete' && !!analysisMatch.root_vfs_path;
              const isActiveSession = activeSessionId === normalizedSessionId;
              const isRunningAnalysis = analysisMatch?.status === 'running' || (isActiveSession && isRunning);
              const workerSessionId =
                analysisMatch?.worker_session_id || (isActiveSession ? activeProcess?.worker_session_id : null);
              const showFlowStatus = isActiveSession && isRunning && !!activeProcess;
              const sessionInfo = getSessionTooltipInfo(session);

              return (
                <div key={session.id} className="border-b border-border last:border-b-0">
                  <div className="grid grid-cols-[120px_1.2fr_1.6fr_90px_80px_100px_190px] items-center gap-2 px-3 py-2 text-xs">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-[10px] text-muted-foreground">
                          {session.modified_at ? new Date(session.modified_at).toLocaleString() : ''}
                          {session.modified_at ? ` (${formatTimeAgo(session.modified_at)})` : ''}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent className="border border-border bg-popover text-popover-foreground shadow-md">
                        <div className="space-y-1 text-[10px]">
                          <div className="flex gap-2">
                            <span className="w-20 text-muted-foreground">Start</span>
                            <span className="truncate">
                              {session.created_at ? new Date(session.created_at).toLocaleString() : '—'}
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <span className="w-20 text-muted-foreground">Last</span>
                            <span className="truncate">
                              {session.modified_at ? new Date(session.modified_at).toLocaleString() : '—'}
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <span className="w-20 text-muted-foreground">Duration</span>
                            <span className="truncate">
                              {formatDuration(session.created_at, session.modified_at) || '—'}
                            </span>
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[10px]">
                        {session.id || session.name || 'ID unavailable'}
                      </div>
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">{session.cwd || '-'}</div>
                    <span>{session.message_count ?? '-'}</span>
                    <span>{totalTokens === null ? '-' : formatCompactNumber(totalTokens)}</span>
                    <span className="text-green-600 dark:text-green-400">
                      {typeof session.estimated_cost_usd === 'number' && session.estimated_cost_usd > 0
                        ? `$${session.estimated_cost_usd.toFixed(4)}`
                        : '-'}
                    </span>
                    <div className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <Info className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs border border-border bg-popover text-popover-foreground shadow-md">
                          {sessionInfo.length === 0 ? (
                            <div className="text-[10px] text-muted-foreground">No session info</div>
                          ) : (
                            <div className="space-y-1 text-[10px]">
                              {sessionInfo.map(([label, value]) => (
                                <div key={label} className="flex gap-2">
                                  <span className="w-16 text-muted-foreground">{label}</span>
                                  <span className="truncate">{value}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleOpenTranscript(session)}
                            disabled={!(session.jsonl_path || session.path) || !computeNode?.typeId}
                          >
                            <Route className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {(session.jsonl_path || session.path) ? 'Open session transcript' : 'Transcript unavailable'}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => handleOpenTodos(session)}
                          >
                            <ListTodo className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Open TODOs (system profile)</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => void handleRunAnalysis(session)}
                            disabled={isRunningAnalysis}
                          >
                            <Play className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{isRunningAnalysis ? 'Running analysis' : 'Analyze'}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => analysisMatch && void handleOpenAnalysisEditor(analysisMatch)}
                            disabled={!canOpen || analysesLoading}
                          >
                            <FilePenLine className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{canOpen ? 'Edit analysis report' : 'Analysis not available'}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => analysisMatch && void handleOpenAnalysisFolder(analysisMatch)}
                            disabled={!canOpen || analysesLoading}
                          >
                            <FolderOpen className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{canOpen ? 'Open analysis folder' : 'Analysis not available'}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => void handleOpenWorkerSession(workerSessionId)}
                            disabled={!workerSessionId}
                          >
                            <Terminal className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {workerSessionId ? 'Open analysis process session' : 'Process session unavailable'}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  {isRunningAnalysis && (
                    <div className="flex items-start justify-between gap-2 border-t border-border/60 bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground">
                      <span className="text-[9px] text-muted-foreground/70">↳</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">Analysis in progress</span>
                          {elapsedTime && <span className="text-[9px] text-muted-foreground/70">({elapsedTime})</span>}
                        </div>
                        {showFlowStatus ? (
                          <div className="mt-1 flex items-center gap-2">
                            {activityLabel && (
                              <span className="text-[9px] text-muted-foreground/80">{activityLabel}</span>
                            )}
                            {statusMessage && <span className="truncate">{statusMessage}</span>}
                          </div>
                        ) : (
                          <div className="mt-1 text-[9px] text-muted-foreground/80">Reconnecting to process…</div>
                        )}
                      </div>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => void handleOpenWorkerSession(workerSessionId)}
                            disabled={!workerSessionId}
                          >
                            <Terminal className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{workerSessionId ? 'Open live session' : 'Session not ready'}</TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {analysesLoading && <div className="text-[10px] text-muted-foreground">Loading analysis results...</div>}
    </div>
  );
}
