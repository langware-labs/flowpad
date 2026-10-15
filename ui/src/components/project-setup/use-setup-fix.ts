import { t } from '@lingui/core/macro';
import { Project, type AgenticProcess, type ProjectLoadResult } from '@sdk';
import { useCallback, useEffect, useState } from 'react';

type SetupFixState =
  | { phase: 'idle' }
  | { phase: 'running'; process: AgenticProcess | null }
  | { phase: 'fixed'; process: AgenticProcess | null; summary: string }
  | { phase: 'not_fixed'; process: AgenticProcess | null; summary: string; userAction: string };

export type SetupFix = ReturnType<typeof useSetupFix>;

function stateOf(asked: boolean, running: boolean, failure: string): SetupFixState {
  if (!asked) return { phase: 'idle' };
  if (running) return { phase: 'running', process: null };
  return {
    phase: 'not_fixed',
    process: null,
    summary: failure,
    userAction: t`The fixer could not repair this setup. The step above says what it found.`,
  };
}

/**
 * "Fix it" for a failed setup — the last step of validate → load → setup → fix. The fixer is not
 * launched here: it is a step of the setup run itself (the setup-fixer rung of each web-app step,
 * `core/setup/derive.py`), so Fix it runs setup again, and Cancel stops that run. What the screen shows
 * is the run's own verdict: the failing step in its own words, the fixer's account included.
 */
export function useSetupFix(
  projectId: string,
  result: ProjectLoadResult | null | undefined,
  error: string | null,
  /** Load again — `true` approves setup, which is what Fix it is. */
  load: (approved?: boolean) => Promise<unknown>,
) {
  const asset = result?.asset ?? '';
  // Fix it pressed: its run is followed through the screen's own verdict until that verdict settles.
  const [asked, setAsked] = useState(false);
  const [pending, setPending] = useState(false);
  // Only a failed verdict is a failure: a project that needs setup carries a `detail` too, and asks Set up.
  const failure = (result?.state === 'failed' ? result.detail : '') || error || '';
  useEffect(() => {
    if (asked && !pending && result?.state === 'ready') setAsked(false);
  }, [asked, pending, result?.state]);

  const start = useCallback(async () => {
    setAsked(true);
    setPending(true);
    try {
      await load(true);
    } finally {
      setPending(false);
    }
  }, [load]);

  const cancel = useCallback(() => {
    void Project.stopSetup(projectId, asset).catch(() => {});
    setAsked(false);
  }, [projectId, asset]);

  const retry = useCallback(() => void load(), [load]);
  const state = stateOf(asked, pending || result?.state === 'running', failure);
  /** Whether the screen shows the failure block: a failure to fix, or a fix under way. */
  const show = !!failure || state.phase !== 'idle';
  // The fixer runs as a step of the setup run, so there is no process of its own to follow here.
  return { state, process: null as AgenticProcess | null, failure, show, start, cancel, retry };
}
