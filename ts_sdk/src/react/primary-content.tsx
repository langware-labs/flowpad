import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

/** A render/paint barrier, not a timer or an all-assets-ready promise. */
export class ContentReadiness {
  private pending = new Set<symbol>();
  private listeners = new Set<() => void>();
  private ready = false;
  private frame: number | undefined;
  private mounted = false;

  getSnapshot = () => this.ready;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  mount() { this.mounted = true; this.schedule(); return () => { this.mounted = false; this.cancel(); }; }
  hold() {
    const token = Symbol();
    this.pending.add(token);
    this.cancel();
    return () => { this.pending.delete(token); this.schedule(); };
  }
  private cancel() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }
  private schedule() {
    this.cancel();
    if (this.ready || !this.mounted || this.pending.size) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        if (!this.mounted || this.pending.size) return;
        this.ready = true;
        performance.mark?.('ui:primary:ready');
        for (const listener of this.listeners) listener();
      });
    });
  }
}

const ReadinessContext = createContext<ContentReadiness | null>(null);
const PrimaryRegion = createContext(false);
const subscribeNothing = () => () => {};
const alreadyReady = () => true;

/** Changing navigation resets scheduling without remounting editors or their buffers. */
export function PrimaryContentProvider({ navigationKey, children }: { navigationKey: string; children: ReactNode }) {
  const readiness = useMemo(() => new ContentReadiness(), [navigationKey]);
  useLayoutEffect(() => readiness.mount(), [readiness]);
  return <ReadinessContext.Provider value={readiness}>{children}</ReadinessContext.Provider>;
}

export function PrimaryContentRegion({ children }: { children: ReactNode }) {
  return <PrimaryRegion.Provider value={true}>{children}</PrimaryRegion.Provider>;
}

export function usePrimaryContentReady(): boolean {
  const readiness = useContext(ReadinessContext);
  return useSyncExternalStore(readiness?.subscribe ?? subscribeNothing, readiness?.getSnapshot ?? alreadyReady, alreadyReady);
}

/** Only identity/ref/content reads in the selected content region participate. */
export function usePrimaryContentPending(pending: boolean): void {
  const readiness = useContext(ReadinessContext);
  const primary = useContext(PrimaryRegion);
  useLayoutEffect(() => pending && primary ? readiness?.hold() : undefined, [pending, primary, readiness]);
}

/** Register a suspended primary component without imposing a new visual fallback. */
export function PrimaryContentFallback() {
  usePrimaryContentPending(true);
  return null;
}
