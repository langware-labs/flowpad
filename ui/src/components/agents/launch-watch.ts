import { type AgenticProcess, isProcessEnded, type ProcessStatus } from '@sdk';

/**
 * The launch-time watch on a process, held as a LEASE.
 *
 * A launch path watches the process before its view mounts (watcher-scoped events — the
 * first turn's status reports — reach the pane only for a watched process). The watch is
 * reference-counted and only the release `watch()` returns decrements it, so the release
 * has to be kept. One lease per process id; it is given back by whichever comes first:
 * the session view unmounting, the process ending (stopped / failed), or the launch
 * failing before any view opens. The view's own watch is separate and balances itself.
 */
interface Lease {
  watch: Promise<() => Promise<void>>;
  /** Stop listening for the process's end. */
  off: () => void;
}

const leases = new Map<string, Lease>();

export function holdLaunchWatch(proc: AgenticProcess): void {
  // An ended process emits no further status, so nothing would ever give its lease back.
  if (leases.has(proc.id) || isProcessEnded(proc.status)) return;
  const off = proc.on('status', (status: ProcessStatus) => {
    if (isProcessEnded(status)) releaseLaunchWatch(proc.id);
  });
  const watch = proc.watch();
  leases.set(proc.id, { watch, off });
  watch.catch((e: unknown) => {
    console.warn('[launch-watch] watch failed; live updates degraded', e);
    if (leases.get(proc.id)?.watch === watch) releaseLaunchWatch(proc.id);
  });
}

export function releaseLaunchWatch(processId: string | null | undefined): void {
  const lease = processId ? leases.get(processId) : undefined;
  if (!processId || !lease) return;
  leases.delete(processId);
  lease.off();
  // The promise is held, not the resolved release: a view that unmounts before the
  // `/watch` POST returns still gives the count back.
  void lease.watch.then((release) => release()).catch(() => undefined);
}

/** Whether a launch lease is held for the process (tests). */
export function hasLaunchWatch(processId: string): boolean {
  return leases.has(processId);
}
