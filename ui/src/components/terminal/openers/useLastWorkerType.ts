import { useCallback } from 'react';
import { PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { type OpenerId } from './tab_opener_types';
import type { WorkerType } from '@src/components/workers/worker-types';

/**
 * Single source of truth for the "last opener / last worker" the user launched.
 *
 * The terminal strip (`usePinnedOpeners`) remembers the last *opener* (a broader
 * set: `claude` / `codex` / `copilot` / `terminal` / `sandbox` / …), while the
 * shared `WorkerToolbar` cares only about the three worker vendors. Both read and
 * write this one preference (`PrefKey.LAST_OPENER`) so launching Claude from
 * either surface keeps the other in sync; prefMan handles reactivity.
 */

// Opener ids and worker types name the same vendors differently (`claude` vs
// `claude_code`); these two maps are the only place that bridges them.
const OPENER_TO_WORKER: Partial<Record<OpenerId, WorkerType>> = {
  claude: 'claude_code',
  codex: 'codex',
  copilot: 'copilot',
};

const WORKER_TO_OPENER: Record<WorkerType, OpenerId> = {
  claude_code: 'claude',
  codex: 'codex',
  copilot: 'copilot',
};

/** Coerce a stored opener id to a worker vendor — null for non-worker openers. */
export function openerToWorker(id: OpenerId | null): WorkerType | null {
  return id ? OPENER_TO_WORKER[id] ?? null : null;
}

/** Coerce a worker vendor to its opener id (for shared persistence). */
export function workerToOpener(worker: WorkerType): OpenerId {
  return WORKER_TO_OPENER[worker];
}

export interface UseLastWorkerTypeResult {
  /** Last worker launched from any surface, or null if none / a non-worker opener. */
  lastWorker: WorkerType | null;
  /** Persist `worker` as the last opener (keeps the terminal strip in sync). */
  rememberWorker: (worker: WorkerType) => void;
}

/**
 * React view over the shared last-opener preference, scoped to worker vendors.
 * Stays live as either the toolbar or the terminal strip writes the key.
 */
export function useLastWorkerType(): UseLastWorkerTypeResult {
  const [lastOpener, setLastOpener] = usePreference<OpenerId | null>(PrefKey.LAST_OPENER);
  const lastWorker = openerToWorker(lastOpener);

  const rememberWorker = useCallback(
    (worker: WorkerType) => {
      setLastOpener(workerToOpener(worker));
    },
    [setLastOpener],
  );

  return { lastWorker, rememberWorker };
}
