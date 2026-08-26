import { isEmptyChatEntry, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';

/** The only two fields the rule reads. Structural so tests need no entity. */
export interface HistoryProcessLike {
  id?: string | null;
  session_id?: string | null;
}

/**
 * The processes the history dropdown offers, with empty chats hidden.
 * Precedence: the active one always stays; no `session_id` PROVES empty (it is
 * minted at start()/prompt(), never at createProcess); no join entry ⇒ keep.
 */
export function selectHistoryProcesses<T extends HistoryProcessLike>(
  processes: readonly T[],
  workerHistoryByProcessId: ReadonlyMap<string, WorkerHistoryEntry>,
  activeId: string | null,
): T[] {
  return processes.filter((p) => {
    if (p.id && p.id === activeId) return true;
    if (!p.session_id) return false;
    const entry = p.id ? workerHistoryByProcessId.get(p.id) : undefined;
    if (!entry) return true;
    return !isEmptyChatEntry(entry);
  });
}
