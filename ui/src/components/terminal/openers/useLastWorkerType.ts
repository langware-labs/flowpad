import { useCallback, useEffect, useState } from 'react';
import { VALID_OPENER_IDS, type OpenerId } from './tab_opener_types';
import type { WorkerType } from '@src/components/workers/worker-types';

/**
 * Single source of truth for the "last opener / last worker" the user launched.
 *
 * The terminal strip (`usePinnedOpeners`) remembers the last *opener* (a broader
 * set: `claude` / `codex` / `copilot` / `terminal` / `sandbox` / …), while the
 * shared `WorkerToolbar` cares only about the three worker vendors. Both read and
 * write this one localStorage key so launching Claude from either surface keeps
 * the other in sync (within the tab via a custom event, across tabs via the
 * native `storage` event).
 */
export const LAST_OPENER_STORAGE_KEY = 'flowpad.terminal.lastOpener';

/** Same-tab change signal — `storage` events only fire in *other* tabs. */
const LAST_OPENER_EVENT = 'flowpad:last-opener-changed';

function isValidOpenerId(value: unknown): value is OpenerId {
  return typeof value === 'string' && (VALID_OPENER_IDS as string[]).includes(value);
}

/** Read the persisted last-opener id (null when unset / invalid). */
export function readLastOpenerId(): OpenerId | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAST_OPENER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidOpenerId(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the last-opener id and notify same-tab listeners. */
export function writeLastOpenerId(id: OpenerId | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) {
      window.localStorage.setItem(LAST_OPENER_STORAGE_KEY, JSON.stringify(id));
    } else {
      window.localStorage.removeItem(LAST_OPENER_STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(LAST_OPENER_EVENT));
  } catch {
    // Ignore storage failures (private mode, quota exceeded).
  }
}

/** Subscribe to last-opener changes from any surface (same tab + cross tab). */
export function subscribeLastOpener(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(LAST_OPENER_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(LAST_OPENER_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

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
 * React view over the shared last-opener key, scoped to worker vendors. Stays
 * live as either the toolbar or the terminal strip writes the key.
 */
export function useLastWorkerType(): UseLastWorkerTypeResult {
  const [lastWorker, setLastWorker] = useState<WorkerType | null>(() => openerToWorker(readLastOpenerId()));

  useEffect(() => subscribeLastOpener(() => setLastWorker(openerToWorker(readLastOpenerId()))), []);

  const rememberWorker = useCallback((worker: WorkerType) => {
    writeLastOpenerId(workerToOpener(worker));
    setLastWorker(worker);
  }, []);

  return { lastWorker, rememberWorker };
}
