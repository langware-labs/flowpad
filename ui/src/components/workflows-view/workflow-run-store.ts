import type { AgenticProcess } from '@sdk';
import type { Shell } from '@sdk/entities/shell';

export interface ProcessEntry {
  process: AgenticProcess;
  /**
   * Only set for Interactive-mode (PTY) entries. CLI-mode runs (workflow runs
   * post the CLI-mode switch) leave this undefined — the status line + navigation
   * flow handle the terminal attach on demand.
   */
  shell?: Shell;
}

// Module-level cache: survives component unmount/remount
const _store = new Map<string, ProcessEntry>();

export const workflowRunStore = {
  set: (id: string, entry: ProcessEntry) => _store.set(id, entry),
  get: (id: string) => _store.get(id),
  delete: (id: string) => _store.delete(id),
};
