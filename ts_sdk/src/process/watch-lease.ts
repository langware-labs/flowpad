import { isProcessEnded, type ProcessStatus } from './agentic-types';

/**
 * The watch on a process that no view holds yet, kept as a LEASE.
 *
 * Whoever creates or launches a process watches it before any view mounts (watcher-scoped
 * events — the first turn's status reports — reach the page only for a watched process).
 * The watch is reference-counted and only the release `watch()` returns decrements it, so
 * the release has to be kept by someone. One lease per process id; it is given back by
 * whichever comes first: an explicit release (the session view unmounting, a launch that
 * failed), the process ending (stopped / failed), the watch failing, or the store dropping
 * the entity. A view's own watch is separate and balances itself.
 */
interface Lease {
  watch: Promise<() => Promise<void>>;
  /** Stop listening for the process's end. */
  off: () => void;
}

/** What the lease needs from a process — `AgenticProcess` satisfies it. */
export interface LeasableProcess {
  id: string;
  status: ProcessStatus;
  watch(): Promise<() => Promise<void>>;
  on(eventType: string, callback: (status: ProcessStatus) => void): () => void;
}

const leases = new Map<string, Lease>();

/**
 * Take the lease, unless one is held or the process already ended. Resolves once the watch
 * is registered (or failed to register), so a caller that prompts next can await it.
 */
export function holdProcessWatch(proc: LeasableProcess): Promise<void> {
  const held = leases.get(proc.id);
  if (held) return settled(held.watch);
  // An ended process emits no further status, so nothing would ever give its lease back.
  if (isProcessEnded(proc.status)) return Promise.resolve();
  const off = proc.on('status', (status: ProcessStatus) => {
    if (!isProcessEnded(status)) return;
    // After the fan-out, not inside it: releasing removes this listener, and the entity's
    // other `status` listeners must all hear the end first.
    queueMicrotask(() => {
      if (leases.get(proc.id) === lease) releaseProcessWatch(proc.id);
    });
  });
  const watch = proc.watch();
  const lease: Lease = { watch, off };
  leases.set(proc.id, lease);
  watch.catch((e: unknown) => {
    console.warn('[watch-lease] watch failed; live updates degraded', e);
    if (leases.get(proc.id)?.watch === watch) releaseProcessWatch(proc.id);
  });
  return settled(watch);
}

export function releaseProcessWatch(processId: string | null | undefined): void {
  const lease = processId ? leases.get(processId) : undefined;
  if (!processId || !lease) return;
  leases.delete(processId);
  lease.off();
  releaseWhenWatched(lease.watch);
}

/**
 * Give back a watch whose `/watch` POST may still be in flight. A holder keeps the PROMISE
 * `watch()` returned, not the resolved release, so letting go before the POST returns
 * still gives the count back.
 */
export function releaseWhenWatched(watch: Promise<() => Promise<void>> | null | undefined): void {
  void watch?.then((release) => release()).catch(() => undefined);
}

export function hasProcessWatch(processId: string): boolean {
  return leases.has(processId);
}

function settled(watch: Promise<unknown>): Promise<void> {
  return watch.then(
    () => undefined,
    () => undefined,
  );
}
