import type { Shell, ShellRunResult } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

/** How often a run this view did not start (found running on arrival) is re-asked about. */
const ADOPTED_POLL_MS = 1000;

export interface ShellRun {
  /** A command runs in the terminal now — one this view started, or one it found running. */
  running: boolean;
  /** When the run this view started began (the clock counts from it); null otherwise. */
  startedAt: number | null;
  /** How the last run this view started ended; null while one runs or before the first. */
  lastExit: ShellRunResult | null;
  /** Type `command` into the terminal and wait for it to end. One at a time: while a run is in
   *  flight a second call does nothing and answers null. */
  run: (command: string) => Promise<ShellRunResult | null>;
  /** Stop the running command (Ctrl-C, then kill); the terminal stays. */
  interrupt: () => Promise<boolean>;
}

/**
 * Run commands in a shell's terminal from a view: the run in flight, its clock, how the last one
 * ended, and Stop. The terminal itself (its output) is the view's `useXtermShellAttach`; this is
 * only the verbs and the state around them.
 *
 * Leaving the view stops the WAIT, never the command — the terminal outlives the view, and a
 * command found running on the next visit is adopted (Stop works, the backend is asked when it ends).
 */
export function useShellRun(shell: Shell | null): ShellRun {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastExit, setLastExit] = useState<ShellRunResult | null>(null);
  const [adopted, setAdopted] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    setStartedAt(null);
    setLastExit(null);
    setAdopted(false);
    if (!shell) return;
    let alive = true;
    void shell
      .runState()
      .then((state) => alive && !inFlight.current && setAdopted(state.running_pid != null))
      .catch(() => undefined);
    return () => {
      alive = false;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [shell]);

  // A run this view did not start ends without telling it: ask until it has.
  useEffect(() => {
    if (!shell || !adopted) return;
    const tick = setInterval(() => {
      void shell
        .runState()
        .then((state) => state.running_pid == null && setAdopted(false))
        .catch(() => undefined);
    }, ADOPTED_POLL_MS);
    return () => clearInterval(tick);
  }, [shell, adopted]);

  const run = useCallback(
    async (command: string): Promise<ShellRunResult | null> => {
      if (!shell || inFlight.current) return null;
      const ac = new AbortController();
      inFlight.current = ac;
      setAdopted(false);
      setLastExit(null);
      setStartedAt(Date.now());
      try {
        const result = await shell.runCommand(command, { signal: ac.signal });
        if (!ac.signal.aborted) setLastExit(result);
        return result;
      } catch (error) {
        if (ac.signal.aborted) return null;
        throw error;
      } finally {
        if (inFlight.current === ac) {
          inFlight.current = null;
          setStartedAt(null);
        }
      }
    },
    [shell],
  );

  const interrupt = useCallback(async () => (shell ? shell.interrupt() : true), [shell]);

  return { running: startedAt !== null || adopted, startedAt, lastExit, run, interrupt };
}
