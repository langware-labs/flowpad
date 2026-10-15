import { t } from '@lingui/core/macro';
import {
  awaitWizardResult,
  isProcessRunning,
  isWorkerTerminal,
  ProcessKind,
  WorkerModelTier,
  type AgenticProcess,
  type ProjectLoadResult,
  type WizardProcessResult,
} from '@sdk';
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useProcessesForTarget } from '@src/components/entity-execution-panel/hooks/useProcessesForTarget';
import { startWizardProcess } from '@src/components/wizard/start-wizard-process';
import { useProcessToolCount } from '@src/hooks/use-agentic-process-stream';

/** The skill that repairs a failed setup flow (`.claude/skills/setup-fixer/SKILL.md`). */
const SKILL = 'setup-fixer';

interface SetupFixAnswer {
  outcome: 'fixed' | 'not_fixed';
  summary: string;
  user_action?: string | null;
}

type SetupFixState =
  | { phase: 'idle' }
  | { phase: 'running'; process: AgenticProcess | null }
  | { phase: 'fixed'; process: AgenticProcess; summary: string }
  | { phase: 'not_fixed'; process: AgenticProcess | null; summary: string; userAction: string };

const IDLE: SetupFixState = { phase: 'idle' };

/** One fix per project, kept outside the screen: leaving and coming back finds the fix running, or the
 *  verdict it reached while nobody was looking. */
const useFixes = create<{ byProject: Record<string, SetupFixState>; set: (id: string, s: SetupFixState) => void }>(
  (set) => ({
    byProject: {},
    set: (id, s) => set((st) => ({ byProject: { ...st.byProject, [id]: s } })),
  }),
);

/** Fixes whose verdict someone already awaits: two screens on one project must not each attach. */
const awaiting = new Set<string>();

/** Fixes the person cancelled: their worker reads as running until it has stopped, and must not be adopted back. */
const stopped = new Set<string>();

export type SetupFix = ReturnType<typeof useSetupFix>;

/**
 * "Fix it" for a failed setup: a plain agentic process — background, fresh context, launched with the
 * setup-fixer skill — that repairs the setup flow, proves the repair, records it in the asset's
 * `rca_log.md`, and closes with a {@link SetupFixAnswer}. A fixed flow is loaded again by the caller.
 */
export function useSetupFix(
  projectId: string,
  result: ProjectLoadResult | null | undefined,
  error: string | null,
  /** Load again: what a fix earns, and what Try again does. */
  reload: () => void,
) {
  const state = useFixes((st) => st.byProject[projectId] ?? IDLE);
  const put = useFixes((st) => st.set);
  // The reload a fix earns belongs to the screen showing it now, whichever one that is.
  const fixed = useRef(reload);
  fixed.current = reload;
  const process = state.phase === 'idle' ? null : state.process;
  const target = `project-${projectId}`;
  const toolCount = useProcessToolCount(state.phase === 'running' ? process : null);
  const failure = result?.detail || error || '';
  const fail = useCallback(
    (summary: string, userAction: string, fixer: AgenticProcess | null = null) =>
      put(projectId, { phase: 'not_fixed', process: fixer, summary, userAction }),
    [projectId, put],
  );

  const settle = useCallback(
    (fixer: AgenticProcess, res: WizardProcessResult<SetupFixAnswer>) => {
      if (stopped.has(fixer.id)) return;
      const answer = res.data;
      if (res.status === 'done' && answer?.outcome === 'fixed') {
        put(projectId, { phase: 'fixed', process: fixer, summary: answer.summary });
        fixed.current();
      } else {
        fail(
          answer?.summary || res.errorStr || '',
          answer?.user_action || t`The fixer could not repair this setup. Open the process to see what it found.`,
          fixer,
        );
      }
    },
    [projectId, put, fail],
  );

  // A fix still running after a reload is picked up again, never started a second time.
  // Asked only while there is a failure or a fix to show — a project that loads fine watches nothing.
  const { processes } = useProcessesForTarget(target, {
    processType: ProcessKind.Wizard,
    enabled: !!failure || state.phase !== 'idle',
  });
  // Its process is up and its worker has not finished: a live list can still read the worker as unknown.
  const running = (processes ?? []).find((p) => {
    const name = (p.context_data?.wizard as { name?: string } | undefined)?.name;
    return name === SKILL && !stopped.has(p.id) && isProcessRunning(p.status) && !isWorkerTerminal(p.workerStatus);
  });
  useEffect(() => {
    if (!running || state.phase !== 'idle' || awaiting.has(running.id)) return;
    awaiting.add(running.id);
    put(projectId, { phase: 'running', process: running });
    void awaitWizardResult<SetupFixAnswer>(running).then((res) => {
      awaiting.delete(running.id);
      settle(running, res);
    });
  }, [running, state.phase, settle, projectId, put]);

  const start = useCallback(async () => {
    if (state.phase === 'running') return;
    put(projectId, { phase: 'running', process: null });
    try {
      const started = await startWizardProcess<SetupFixAnswer>(
        {
          wizardName: SKILL,
          wizardData: {
            title: t`Fix the setup`,
            model: WorkerModelTier.MD,
            targetTypeId: target,
            prompt: `Use the ${SKILL} skill to fix this failed setup.`,
            payload: {
              error: failure,
              project_id: projectId,
              asset: result?.asset ?? null,
              tree: result?.tree ?? null,
            },
            resultShape: {
              outcome: '<fixed|not_fixed>',
              summary: '<one line: what was wrong and what you did>',
              user_action: '<when not_fixed: what the person must do, in plain words; else null>',
            },
          },
        },
        { headless: true, skill: true },
      );
      // Cancelled while it was still starting: the process that just came up is not wanted.
      if (useFixes.getState().byProject[projectId]?.phase !== 'running') {
        stopped.add(started.process.id);
        void started.process.cancelPrompt().catch(() => {});
        return;
      }
      awaiting.add(started.process.id);
      put(projectId, { phase: 'running', process: started.process });
      const res = await started.result;
      awaiting.delete(started.process.id);
      settle(started.process, res);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), t`The fixer could not start.`);
    }
  }, [state.phase, failure, result, target, projectId, put, settle, fail]);

  const cancel = useCallback(() => {
    if (process) {
      stopped.add(process.id);
      // A headless run is a print-mode turn: cancelling the turn is what stops its worker.
      void process.cancelPrompt().catch(() => {});
    }
    put(projectId, IDLE);
  }, [process, projectId, put]);

  const retry = useCallback(() => fixed.current(), []);
  return { state, process, failure, toolCount, start, cancel, retry };
}
