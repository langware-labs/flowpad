import { WorkerModelTier } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWizardRun } from '@src/hooks/use-wizard-run';
import type { WebappVerdict } from './classify';

/** The wizard agent that repairs a broken web app (see `.claude/agents/webapp-fixer.md`). */
const FIXER = 'webapp-fixer';

export interface WebappFix {
  /** 'idle' | 'running' — drives the button label and the frozen verdict. */
  running: boolean;
  toolCount: number;
  start: () => void;
  /** True once an automatic attempt has been spent on the current failure. */
  autoAttempted: boolean;
}

interface Options {
  verdict: WebappVerdict;
  port: string | null;
  url: string;
  workdir?: string | null;
  /** Subject the run attaches to, so it survives a refresh and is reconnectable. */
  targetTypeId?: string | null;
  /** Re-probe once the agent claims to be done. */
  onFinished: () => void;
}

/**
 * Runs the repair agent for a broken web app.
 *
 * Deliberately cheap: the run is pinned to the SMALL model tier. These failures
 * are overwhelmingly mechanical — a server that stopped, a bad import, a missing
 * asset — and a fast, inexpensive fix that the user can re-trigger beats a slow
 * expensive one they hesitate to click.
 *
 * The automatic attempt is fired at most ONCE per distinct failure. Without that
 * guard the loop is vicious: the agent restarts the dev server, the port drops
 * for a moment, that reads as a new fatal, and another paid run starts.
 */
export function useWebappFix({ verdict, port, url, workdir, targetTypeId, onFinished }: Options): WebappFix {
  const [autoAttempted, setAutoAttempted] = useState(false);
  // Identity of the failure being repaired, so a *different* fault later still
  // earns its own automatic attempt.
  const attemptedSignature = useRef<string | null>(null);
  const signature = `${url}::${verdict.code}`;

  const run = useWizardRun({
    wizardName: FIXER,
    successMessage: 'Your app should be working now',
    errorTitle: 'Could not fix the app',
    buildRequest: () => ({
      title: 'Fix the web app',
      model: WorkerModelTier.SM,
      targetTypeId: targetTypeId ?? undefined,
      payload: {
        code: verdict.code,
        detail: verdict.detail,
        port,
        url,
        workdir: workdir ?? null,
      },
      resultShape: { fixed: '<true|false>', summary: '<what was wrong and what you did>' },
    }),
    onResult: () => onFinished(),
  });

  // A new fault resets the budget; the same fault does not.
  useEffect(() => {
    if (attemptedSignature.current && attemptedSignature.current !== signature) {
      attemptedSignature.current = null;
      setAutoAttempted(false);
    }
  }, [signature]);

  const start = useCallback(() => {
    attemptedSignature.current = signature;
    setAutoAttempted(true);
    run.onClick();
  }, [run, signature]);

  return {
    running: run.phase === 'running',
    toolCount: run.toolCount,
    start,
    autoAttempted,
  };
}
