import type { AgenticProcess } from '@sdk';

export interface ProcessEntry {
  process: AgenticProcess;
  shellId: string;
}

// Module-level cache: survives component unmount/remount
const _store = new Map<string, ProcessEntry>();

export const workflowRunStore = {
  set: (id: string, entry: ProcessEntry) => _store.set(id, entry),
  get: (id: string) => _store.get(id),
  delete: (id: string) => _store.delete(id),
};
