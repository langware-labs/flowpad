import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

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
  /** Not mounted yet: the provider's first barrier, taken by its first navigation. */
  isFresh() { return !this.mounted && !this.ready; }
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

/**
 * The provider's stable face: subscribers and holds always reach the CURRENT
 * navigation's readiness. The context value never changes, so a navigation does
 * not re-render every `usePrimaryContentReady` consumer: the gate for the new
 * page closes silently, and when it opens only the consumers that rendered while
 * it was closed (the new page's background widgets) re-render.
 */
class ReadinessFacade {
  current: ContentReadiness;
  private listeners = new Set<() => void>();
  constructor() {
    this.current = this.next();
  }
  next(): ContentReadiness {
    const readiness = new ContentReadiness();
    readiness.subscribe(() => {
      if (this.current === readiness) for (const listener of this.listeners) listener();
    });
    return readiness;
  }
  getSnapshot = () => this.current.getSnapshot();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  hold() {
    return this.current.hold();
  }
}

const ReadinessContext = createContext<ReadinessFacade | null>(null);
const PrimaryRegion = createContext(false);
const subscribeNothing = () => () => {};
const alreadyReady = () => true;

/** Changing navigation resets scheduling without remounting editors or their buffers. */
export function PrimaryContentProvider({ navigationKey, children }: { navigationKey: string; children: ReactNode }) {
  const [facade] = useState(() => new ReadinessFacade());
  // A fresh barrier per navigation (holds of the page being left die with the old one).
  const readiness = useMemo(
    () => (facade.current.isFresh() ? facade.current : facade.next()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigationKey],
  );
  facade.current = readiness;
  useLayoutEffect(() => readiness.mount(), [readiness]);
  return <ReadinessContext.Provider value={facade}>{children}</ReadinessContext.Provider>;
}

export function PrimaryContentRegion({ children }: { children: ReactNode }) {
  return <PrimaryRegion.Provider value={true}>{children}</PrimaryRegion.Provider>;
}

/**
 * Latched per consumer: the barrier holds back the background widgets of the page
 * being OPENED. A widget that has already seen it open is on screen with its data;
 * gating it again on every navigation only re-rendered it twice per tab switch
 * (closed, then open — its query toggling `enabled` in between) for nothing.
 */
export function usePrimaryContentReady(): boolean {
  const readiness = useContext(ReadinessContext);
  const latched = useRef(false);
  const live = !latched.current && readiness;
  const ready = useSyncExternalStore(
    live ? live.subscribe : subscribeNothing,
    live ? live.getSnapshot : alreadyReady,
    alreadyReady,
  );
  if (ready) latched.current = true;
  return ready;
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
