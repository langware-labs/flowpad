import { useCallback, useEffect, useRef, useState } from 'react';
import { AgenticProcess, dataContext, fsManager, ProcessResult, Task } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { TaskType } from '@src/components/task-bar/task-utils';
import { useToast } from '@src/hooks/use-toast';
import { validateProcessContext } from '@src/hooks/process-context';

interface UseSessionClassifyOptions {
  /** The current session ID (to check classification status for this specific session) */
  currentSessionId?: string;
  /** Called after the process starts executing. Use to trigger a refetch of resources, etc. */
  onStarted?: () => void;
  /** Called after the process completes (success or error). Use to trigger a refetch so results appear. */
  onCompleted?: () => void;
}

interface UseSessionClassifyResult {
  classifySession: (sessionId: string, cwd: string) => Promise<void>;
  classifyingSessionIds: ReadonlySet<string>;
  /** Map of source session ID → worker session ID for navigating to running classifications */
  workerSessionIds: ReadonlyMap<string, string>;
  classificationExists: boolean;
  isWorkerSession: boolean;
}

/**
 * Hook that encapsulates the session classification flow:
 * creates a Task + AgenticProcess + ProcessResult, then executes the
 * classify instruction and tracks status updates.
 *
 * Supports parallel classification of multiple sessions.
 */
export function useSessionClassify(options?: UseSessionClassifyOptions): UseSessionClassifyResult {
  const { project: currentProject } = useProject();
  const { toast } = useToast();
  const currentSessionId = options?.currentSessionId;
  const onStartedRef = useRef(options?.onStarted);
  onStartedRef.current = options?.onStarted;
  const onCompletedRef = useRef(options?.onCompleted);
  onCompletedRef.current = options?.onCompleted;
  const [classifyingSessionIds, setClassifyingSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [workerSessionIds, setWorkerSessionIds] = useState<ReadonlyMap<string, string>>(new Map());
  const [classificationExists, setClassificationExists] = useState(false);
  const [isWorkerSession, setIsWorkerSession] = useState(false);

  // Track which sessions are currently running (prevents double invocation per session)
  const runningSessionsRef = useRef<Set<string>>(new Set());

  // Single fetch: derive both classificationExists and isWorkerSession from one Task.read()
  useEffect(() => {
    if (!currentSessionId) return;

    let cancelled = false;
    const checkClassificationStatus = async () => {
      try {
        const allTasks = await Task.read();
        if (cancelled) return;
        const classificationTasks = allTasks.filter(t => t.task_type === TaskType.CLASSIFICATION);

        setClassificationExists(
          classificationTasks.some(t => t.metadata?.sessionId === currentSessionId && t.status === 'done'),
        );
        setIsWorkerSession(
          classificationTasks.some(t => t.metadata?.workerSessionId === currentSessionId),
        );
      } catch {
        if (!cancelled) {
          setClassificationExists(false);
          setIsWorkerSession(false);
        }
      }
    };
    void checkClassificationStatus();

    return () => { cancelled = true; };
  }, [currentSessionId]);

  const classifySession = useCallback(
    async (sessionId: string, cwd: string) => {
      if (runningSessionsRef.current.has(sessionId)) return;

      const ctx = validateProcessContext(toast);
      if (!ctx) return;
      ctx.projectTypeId = currentProject?.typeId;

      const addSession = (workerSid: string) => {
        runningSessionsRef.current.add(sessionId);
        setClassifyingSessionIds(prev => new Set([...prev, sessionId]));
        setWorkerSessionIds(prev => new Map([...prev, [sessionId, workerSid]]));
      };

      const removeSession = () => {
        runningSessionsRef.current.delete(sessionId);
        setClassifyingSessionIds(prev => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
        setWorkerSessionIds(prev => {
          const next = new Map(prev);
          next.delete(sessionId);
          return next;
        });
      };

      try {
        const taskType = TaskType.CLASSIFICATION;
        const resultUnamePrefix = 'sc';
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
          title: `Classify ${sessionId}`,
          status: 'in_progress',
          task_type: taskType,
          priority: 'medium',
          tags: ['classification'],
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
          console.error('[useSessionClassify] Failed to persist running state:', error);
        }

        // 4. Completion listeners
        const classificationPathAbs = `${resolvedOutputDir}/classification.json`;

        const updateStatus = async (status: 'complete' | 'error') => {
          let extraMeta: Record<string, unknown> = {};
          if (status === 'complete') {
            try {
              const content = await fsManager.download(ctx.computeNodeTypeId, classificationPathAbs);
              if (content) {
                const text = typeof content === 'string' ? content : new TextDecoder().decode(content as ArrayBuffer);
                const parsed = JSON.parse(text) as Record<string, unknown>;
                if (parsed.category && parsed.title && parsed.command) {
                  extraMeta = {
                    classificationPath: classificationPathAbs,
                    classification_category: parsed.category,
                    classification_title: parsed.title,
                    classification_command: parsed.command,
                    classification_confidence: parsed.confidence,
                  };
                }
              }
            } catch (error) {
              console.warn('[useSessionClassify] Could not read classification.json:', error);
              extraMeta = { classificationPath: classificationPathAbs };
            }
          }

          try {
            const result = await ProcessResult.getById(`@${resultUname}`);
            if (result) {
              result.status = status;
              result.worker_session_id = generatedWorkerSessionId;
              await result.save();
            }
          } catch (error) {
            console.error('[useSessionClassify] Failed to update ProcessResult:', error);
          }

          try {
            task.status = status === 'complete' ? 'done' : 'open';
            task.metadata = {
              ...taskMetadata,
              ...(status === 'complete'
                ? { completedAt: new Date().toISOString(), ...extraMeta }
                : {}),
            };
            await task.save(taskScope);
          } catch (error) {
            console.error('[useSessionClassify] Failed to update Task:', error);
          }

          removeSession();
          onCompletedRef.current?.();
        };

        process.on('complete', () => void updateStatus('complete'));
        process.on('error', () => void updateStatus('error'));

        // 5. Execute instruction — plain text, no plugin call
        const instruction = [
          `Classify this Claude Code session and write the result to ${classificationPathAbs}.`,
          '',
          'Output a JSON file with these fields:',
          '  category: string  (e.g. "coding", "debugging", "analysis", "writing")',
          '  title: string     (concise session title)',
          '  command: string   (primary intent in imperative form)',
          '  confidence: number (0.0–1.0)',
          '',
          `mkdir -p ${resolvedOutputDir}`,
        ].join('\n');

        await process.executeInstruction(instruction, {
          sync: false,
          workerSessionId: generatedWorkerSessionId,
        });

        addSession(generatedWorkerSessionId);

        if (onStartedRef.current) {
          setTimeout(onStartedRef.current, 1000);
        }
      } catch (error) {
        console.error('[useSessionClassify] Failed to run session classification:', error);
        toast({
          title: 'Classification failed',
          description: `Could not start the classification: ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'destructive',
        });
        removeSession();
      }
    },
    [currentProject?.typeId, toast],
  );

  return { classifySession, classifyingSessionIds, workerSessionIds, classificationExists, isWorkerSession };
}
