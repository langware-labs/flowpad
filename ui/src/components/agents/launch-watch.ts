import type { AgenticProcess } from '@sdk';
import { hasProcessWatch, holdProcessWatch, releaseProcessWatch } from '@sdk/process/watch-lease';

/**
 * The launch-time watch on a process is the SDK's lease (ts_sdk/src/process/watch-lease.ts,
 * the one behind `AgenticProcess.watchWhileLive`): one per process id, given back by the
 * session view unmounting, the process ending, or the launch failing before any view opens.
 * These are the launch paths' names for it.
 */
export function holdLaunchWatch(proc: AgenticProcess): void {
  void holdProcessWatch(proc);
}

export const releaseLaunchWatch = releaseProcessWatch;

/** Whether a launch lease is held for the process (tests). */
export const hasLaunchWatch = hasProcessWatch;
