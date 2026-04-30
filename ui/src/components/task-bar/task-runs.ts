import type { AgenticProcess } from '@sdk';
import type { ProcessEntry } from '@src/components/workflows-view/workflow-run-store';

/** Sort processes newest-first and wrap each as a `ProcessEntry` for `WorkflowRunsPanel`. */
export function buildRunEntries(processes: readonly AgenticProcess[]): ProcessEntry[] {
  const sorted = [...processes].sort((a, b) => {
    const aDate = a.created_date ? new Date(a.created_date).getTime() : 0;
    const bDate = b.created_date ? new Date(b.created_date).getTime() : 0;
    return bDate - aDate;
  });
  return sorted.map((process) => ({ process }));
}
