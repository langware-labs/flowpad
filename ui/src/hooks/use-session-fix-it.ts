import { useCallback, useRef, useState } from 'react';
import { AgenticProcess, fsManager, ProcessResult, Task } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useToast } from '@src/hooks/use-toast';
import { validateProcessContext } from '@src/hooks/process-context';

interface UseSessionFixItOptions {
  /** Called after the process starts executing. */
  onStarted?: () => void;
}

interface UseSessionFixItResult {
  fixErrors: (sessionId: string, cwd: string, errorsFilePath: string) => Promise<void>;
  isRunning: boolean;
}

/**
 * Hook that encapsulates the fix-it flow:
 * forks from a session to fix errors listed in a file.
 */
export function useSessionFixIt(options?: UseSessionFixItOptions): UseSessionFixItResult {
  const { project: currentProject } = useProject();
  const { toast } = useToast();
  const onStartedRef = useRef(options?.onStarted);
  onStartedRef.current = options?.onStarted;
  const [isRunning, setIsRunning] = useState(false);

  const runningRef = useRef(false);

  const fixErrors = useCallback(
    async (sessionId: string, cwd: string, errorsFilePath: string) => {
      if (runningRef.current) return;

      const ctx = validateProcessContext(toast);
      if (!ctx) return;
      ctx.projectTypeId = currentProject?.typeId;

      try {
        runningRef.current = true;
        setIsRunning(true);

        const taskType = 'fix_it';
        const resultUnamePrefix = 'fi';
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

        // 2. Output folder — prefer the process's own FSRef; fall back to the
        //    legacy layout so pre-migration processes still work.
        const normalizedHome = ctx.homePath.startsWith('/') ? ctx.homePath : `/${ctx.homePath}`;
        const resolvedOutputDir =
          process.output_folder?.path ?? `${normalizedHome}/.flow/sessions/${process.id}`;
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
          title: `Fix errors (${sessionId.slice(0, 8)})`,
          status: 'in_progress',
          task_type: taskType,
          priority: 'medium',
          tags: ['fix-it'],
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
          console.error('[useSessionFixIt] Failed to persist running state:', error);
        }

        // 4. Completion listeners
        const updateStatus = async (status: 'complete' | 'error') => {
          try {
            const result = await ProcessResult.getById(`@${resultUname}`);
            if (result) {
              result.status = status;
              result.worker_session_id = generatedWorkerSessionId;
              await result.save();
            }
          } catch (error) {
            console.error('[useSessionFixIt] Failed to update ProcessResult:', error);
          }

          try {
            task.status = status === 'complete' ? 'done' : 'open';
            task.metadata = {
              ...taskMetadata,
              ...(status === 'complete' ? { completedAt: new Date().toISOString() } : {}),
            };
            await task.save(taskScope);
          } catch (error) {
            console.error('[useSessionFixIt] Failed to update Task:', error);
          }

          runningRef.current = false;
          setIsRunning(false);
        };

        process.on('complete', () => void updateStatus('complete'));
        process.on('error', () => void updateStatus('error'));

        // 5. Execute instruction
        const instruction = `Fix the errors listed in ${errorsFilePath}. Save a fix report to ${resolvedOutputDir}/fix-report.md.`;
        await process.executeInstruction(instruction, {
          sync: false,
          workerSessionId: generatedWorkerSessionId,
        });

        if (onStartedRef.current) {
          setTimeout(onStartedRef.current, 1000);
        }
      } catch (error) {
        console.error('[useSessionFixIt] Failed to run fix-it:', error);
        toast({
          title: 'Fix-it failed',
          description: `Could not start fix-it: ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'destructive',
        });
        runningRef.current = false;
        setIsRunning(false);
      }
    },
    [currentProject?.typeId, toast],
  );

  return { fixErrors, isRunning };
}
