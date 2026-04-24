import { useCallback, useRef, useState } from 'react';
import { AgenticProcess, fsManager, ProcessResult, Task } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { TaskType } from '@src/components/task-bar/task-utils';
import { useToast } from '@src/hooks/use-toast';
import { validateProcessContext } from '@src/hooks/process-context';

/** Map classification command names to task_type values. */
const COMMAND_TASK_TYPE: Record<string, string> = {
  'create-skill': TaskType.SKILL_CREATION,
  'create-memory': TaskType.MEMORY_CREATION,
  'create-rule': TaskType.RULE_CREATION,
  'create-hook': TaskType.HOOK_CREATION,
};

/** Build a plain-text instruction for each command. */
function buildCommandInstruction(command: string, outputDir: string): string {
  const base = `Save the result to ${outputDir}/`;
  switch (command) {
    case 'create-skill':
      return [
        'Analyze this Claude Code session and create a skill file that captures the key patterns or workflow.',
        `${base}skill/SKILL.md`,
      ].join('\n');
    case 'create-memory':
      return [
        'Analyze this Claude Code session and create a persistent memory entry capturing important context.',
        `${base}memory.md`,
      ].join('\n');
    case 'create-rule':
      return [
        'Analyze this Claude Code session and create a coding rule that encodes a constraint or standard.',
        `${base}rule.md`,
      ].join('\n');
    case 'create-hook':
      return [
        'Analyze this Claude Code session and create a trigger/hook that automates a recurring workflow.',
        `${base}hook.md`,
      ].join('\n');
    default:
      return `Execute action: ${command}. Save results to ${outputDir}/output.md`;
  }
}

interface UseActAccordingToClassificationOptions {
  onStarted?: () => void;
  onCompleted?: () => void;
}

interface UseActAccordingToClassificationResult {
  actOnClassification: (sessionId: string, cwd: string, command: string) => Promise<void>;
  actingSessionId: string | null;
  workerSessionId: string | null;
}

/**
 * Hook that executes phase 2 of the classification workflow:
 * runs the appropriate action (create-skill, create-memory, etc.)
 * based on the classification result.
 */
export function useActAccordingToClassification(
  options?: UseActAccordingToClassificationOptions,
): UseActAccordingToClassificationResult {
  const { project: currentProject } = useProject();
  const { toast } = useToast();
  const onStartedRef = useRef(options?.onStarted);
  onStartedRef.current = options?.onStarted;
  const onCompletedRef = useRef(options?.onCompleted);
  onCompletedRef.current = options?.onCompleted;
  const [actingSessionId, setActingSessionId] = useState<string | null>(null);
  const [workerSessionId, setWorkerSessionId] = useState<string | null>(null);

  const runningRef = useRef(false);

  const actOnClassification = useCallback(
    async (sessionId: string, cwd: string, command: string) => {
      if (runningRef.current) return;

      const ctx = validateProcessContext(toast);
      if (!ctx) return;
      ctx.projectTypeId = currentProject?.typeId;

      const taskType = COMMAND_TASK_TYPE[command] || TaskType.SKILL_CREATION;

      const resetState = () => {
        runningRef.current = false;
        setActingSessionId(null);
        setWorkerSessionId(null);
      };

      try {
        runningRef.current = true;
        setActingSessionId(sessionId);

        const generatedWorkerSessionId = crypto.randomUUID();
        const sessionSlug = sessionId.replace(/[^a-zA-Z0-9_-]+/g, '_');
        const resultUname = `ca_${sessionSlug}_${Date.now()}`;

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
          command,
        };
        const task = new Task({
          title: `${command} for ${sessionId}`,
          status: 'in_progress',
          task_type: taskType,
          priority: 'medium',
          tags: [taskType],
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
          console.error('[useActAccordingToClassification] Failed to persist running state:', error);
        }

        // 4. Completion listeners
        const updateStatus = async (status: 'complete' | 'error') => {
          let extraMeta: Record<string, unknown> = {};
          if (status === 'complete') {
            try {
              const listing = await fsManager.ls(ctx.computeNodeTypeId, resolvedOutputDir);
              if (listing) {
                const dirs = Array.isArray(listing) ? listing : [];
                for (const entry of dirs) {
                  const name = typeof entry === 'string' ? entry : (entry as { name?: string })?.name;
                  if (!name || name.startsWith('.')) continue;
                  try {
                    const skillMdPath = `${resolvedOutputDir}/${name}/SKILL.md`;
                    const content = await fsManager.download(ctx.computeNodeTypeId, skillMdPath);
                    if (content) {
                      extraMeta = {
                        skillName: name,
                        folderName: name,
                        skillScope: 'user',
                        skillPath: skillMdPath,
                      };
                      break;
                    }
                  } catch {
                    // Not a skill directory, continue
                  }
                }
              }
            } catch (error) {
              console.warn('[useActAccordingToClassification] Could not scan output directory:', error);
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
            console.error('[useActAccordingToClassification] Failed to update ProcessResult:', error);
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
            console.error('[useActAccordingToClassification] Failed to update Task:', error);
          }

          resetState();
          onCompletedRef.current?.();
        };

        process.on('complete', () => void updateStatus('complete'));
        process.on('error', () => void updateStatus('error'));

        // 5. Execute instruction
        const instruction = buildCommandInstruction(command, resolvedOutputDir);
        await process.executeInstruction(instruction, {
          sync: false,
          workerSessionId: generatedWorkerSessionId,
        });

        setWorkerSessionId(generatedWorkerSessionId);

        if (onStartedRef.current) {
          setTimeout(onStartedRef.current, 1000);
        }
      } catch (error) {
        console.error('[useActAccordingToClassification] Failed to run action:', error);
        toast({
          title: 'Action failed',
          description: `Could not start ${command}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'destructive',
        });
        resetState();
      }
    },
    [currentProject?.typeId, toast],
  );

  return { actOnClassification, actingSessionId, workerSessionId };
}
