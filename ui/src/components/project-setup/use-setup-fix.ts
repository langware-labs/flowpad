import { t } from '@lingui/core/macro';
import { AgenticProcess, Project, type ProjectLoadResult, type ProjectSetupFix } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

type SetupFixState =
  | { phase: 'idle' }
  | { phase: 'running'; process: AgenticProcess | null }
  | { phase: 'fixed'; process: AgenticProcess | null; summary: string }
  | { phase: 'not_fixed'; process: AgenticProcess | null; summary: string; userAction: string };

/** How often a running fix is asked for its verdict. */
const POLL_MS = 2000;

export type SetupFix = ReturnType<typeof useSetupFix>;

function stateOf(fix: ProjectSetupFix | null, process: AgenticProcess | null): SetupFixState {
  if (!fix) return { phase: 'idle' };
  if (fix.state === 'running') return { phase: 'running', process };
  if (fix.state === 'fixed') return { phase: 'fixed', process, summary: fix.summary };
  return {
    phase: 'not_fixed',
    process,
    summary: fix.summary,
    userAction: fix.user_action || t`The fixer could not repair this setup. Open the process to see what it found.`,
  };
}

/**
 * "Fix it" for a failed setup — the last step of validate → load → setup → fix. The BACKEND launches the
 * setup-fixer on a load whose setup failed (whoever asked for the load) and carries its verdict on the
 * load's answer (`result.fix`); this screen only shows it, asks for it again, or stops it. A fix that
 * worked is loaded again by the backend; the screen reloads to follow it.
 */
export function useSetupFix(
  projectId: string,
  result: ProjectLoadResult | null | undefined,
  error: string | null,
  /** Load again: what a fix earns, and what Try again does. */
  reload: () => void,
) {
  const asset = result?.asset ?? '';
  const [fix, setFix] = useState<ProjectSetupFix | null>(result?.fix ?? null);
  const [process, setProcess] = useState<AgenticProcess | null>(null);
  const fixed = useRef(reload);
  fixed.current = reload;
  useEffect(() => setFix(result?.fix ?? null), [result]);

  const processId = fix?.process?.replace(/^agentic_process-/, '') ?? null;
  useEffect(() => {
    if (!processId) return setProcess(null);
    let live = true;
    void AgenticProcess.getById(processId)
      .then((p) => live && setProcess(p ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [processId]);

  // A running fix is followed to its verdict; one that worked loads again.
  useEffect(() => {
    if (fix?.state !== 'running') return;
    const timer = setInterval(() => {
      void Project.loadState(projectId, asset).then((now) => {
        const next = now?.fix ?? null;
        setFix(next);
        if (next?.state === 'fixed') fixed.current();
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fix?.state, projectId, asset]);

  const start = useCallback(async () => {
    try {
      const now = await Project.setupFix(projectId, asset);
      setFix(now?.fix ?? null);
    } catch (err) {
      setFix({
        state: 'not_fixed',
        process: null,
        summary: err instanceof Error ? err.message : String(err),
        user_action: t`The fixer could not start.`,
      });
    }
  }, [projectId, asset]);

  const cancel = useCallback(() => {
    void Project.setupFix(projectId, asset, true).catch(() => {});
    setFix(null);
  }, [projectId, asset]);

  const retry = useCallback(() => fixed.current(), []);
  const state = stateOf(fix, process);
  const failure = result?.detail || error || '';
  /** Whether the screen shows the failure block: a failure to fix, or a fix to report. */
  const show = !!failure || state.phase !== 'idle';
  return { state, process, failure, show, start, cancel, retry };
}
