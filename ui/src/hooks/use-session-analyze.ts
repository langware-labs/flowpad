import { useCallback, useRef, useState } from 'react';
import { AgenticProcess, fsManager, ProcessResult, Task } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useToast } from '@src/hooks/use-toast';
import { validateProcessContext } from '@src/hooks/process-context';

interface UseSessionAnalyzeOptions {
  /** Called after the process starts executing. Use to trigger a refetch of resources, etc. */
  onStarted?: () => void;
}

interface UseSessionAnalyzeResult {
  analyzeSession: (sessionId: string, cwd: string) => Promise<void>;
  analyzingSessionId: string | null;
  /** Claude session ID of the running analysis fork, for navigating to it */
  workerSessionId: string | null;
}

/**
 * Hook that encapsulates the session analysis flow:
 * creates a Task + AgenticProcess + ProcessResult, then executes the
 * analysis instruction and tracks status updates.
 *
 * Reusable across HomeLanding, SessionViewer, or anywhere a session
 * can be analyzed.
 */
export function useSessionAnalyze(options?: UseSessionAnalyzeOptions): UseSessionAnalyzeResult {
  const { project: currentProject } = useProject();
  const { toast } = useToast();
  const onStartedRef = useRef(options?.onStarted);
  onStartedRef.current = options?.onStarted;
  const [analyzingSessionId, setAnalyzingSessionId] = useState<string | null>(null);
  const [workerSessionId, setWorkerSessionId] = useState<string | null>(null);

  // Guard against double invocation (React strict mode)
  const runningRef = useRef(false);

  const analyzeSession = useCallback(
    async (sessionId: string, cwd: string) => {
      if (runningRef.current) return;

      const ctx = validateProcessContext(toast);
      if (!ctx) return;
      ctx.projectTypeId = currentProject?.typeId;

      const resetState = () => {
        runningRef.current = false;
        setAnalyzingSessionId(null);
        setWorkerSessionId(null);
      };

      try {
        runningRef.current = true;
        setAnalyzingSessionId(sessionId);

        const taskType = 'analysis';
        const resultUnamePrefix = 'sa';
        const generatedWorkerSessionId = crypto.randomUUID();
        const resultUname = `${resultUnamePrefix}_${sessionId.slice(0, 8)}`;

        // 1. Spawn headless — need process.id to build outputDir
        const { process } = await AgenticProcess.spawn(
          {
            workdir: cwd,
            permissionMode: 'bypassPermissions',
            resumeSessionId: sessionId,
            forkSession: true,
          },
          {
            headless: true,
            result: { uname: resultUname, resultType: taskType, sourceSessionId: sessionId },
          },
        );

        // 2. Resolve outputDir now that we have process.id
        const normalizedHome = ctx.homePath.startsWith('/') ? ctx.homePath : `/${ctx.homePath}`;
        const resolvedOutputDir = `${normalizedHome}/.flow/sessions/${process.id}`;
        await fsManager.mkdir(ctx.computeNodeTypeId, resolvedOutputDir);

        // 3. Task + ProcessResult creation
        const taskMetadata: Record<string, unknown> = {
          processId: process.id,
          sessionId,
          resultUname,
          workerSessionId: generatedWorkerSessionId,
          output_dir: resolvedOutputDir,
        };
        const task = new Task({
          title: `Analyse ${sessionId}`,
          status: 'in_progress',
          task_type: taskType,
          priority: 'medium',
          tags: ['analysis'],
          metadata: taskMetadata,
        });
        const taskScope = ctx.projectTypeId ? [ctx.projectTypeId] : [];
        await task.save(taskScope);

        try {
          const earlyResult = await ProcessResult.getById(`@${resultUname}`);
          if (earlyResult) {
            earlyResult.status = 'running';
            earlyResult.worker_session_id = generatedWorkerSessionId;
            await earlyResult.save();
          }
        } catch (error) {
          console.error('[useSessionAnalyze] Failed to persist running state:', error);
        }

        // 4. Completion listeners
        const updateStatus = async (status: 'complete' | 'error') => {
          try {
            const result = await ProcessResult.getById(`@${resultUname}`);
            if (result) {
              result.status = status;
              result.worker_session_id = generatedWorkerSessionId;
              if (status === 'complete') {
                (result as Record<string, unknown>).analysisPath = `${resolvedOutputDir}/analysis.md`;
              }
              await result.save();
            }
          } catch (error) {
            console.error('[useSessionAnalyze] Failed to update ProcessResult:', error);
          }

          try {
            task.status = status === 'complete' ? 'done' : 'open';
            task.metadata = {
              ...taskMetadata,
              ...(status === 'complete'
                ? { completedAt: new Date().toISOString(), analysisPath: `${resolvedOutputDir}/analysis.md` }
                : {}),
            };
            await task.save(taskScope);
          } catch (error) {
            console.error('[useSessionAnalyze] Failed to update Task:', error);
          }

          resetState();
        };

        process.on('complete', () => void updateStatus('complete'));
        process.on('error', () => void updateStatus('error'));

        // 5. Execute instruction
        const instruction = `Analyze the session. Save the analysis report to ${resolvedOutputDir}/analysis.md.`;
        await process.executeInstruction(instruction, {
          sync: false,
          workerSessionId: generatedWorkerSessionId,
        });

        setWorkerSessionId(generatedWorkerSessionId);

        if (onStartedRef.current) {
          setTimeout(onStartedRef.current, 1000);
        }
      } catch (error) {
        console.error('[useSessionAnalyze] Failed to run session analysis:', error);
        toast({
          title: 'Analysis failed',
          description: `Could not start the analysis: ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'destructive',
        });
        resetState();
      }
    },
    [currentProject?.typeId, toast],
  );

  return { analyzeSession, analyzingSessionId, workerSessionId };
}
