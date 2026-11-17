import { ContextEventType, dataContext } from '../../FlowSync/context';
import { useCallback, useRef, useSyncExternalStore } from 'react';

// Single subscription manager to avoid multiple EventEmitter listeners
// All React components subscribe to this manager, which has one listener to dataContext
class ContextSubscriptionManager {
  private listeners = new Set<() => void>();
  private isSubscribed = false;

  subscribe(callback: () => void) {
    this.listeners.add(callback);

    // Subscribe to dataContext events only once
    if (!this.isSubscribed) {
      this.isSubscribed = true;
      dataContext.on(ContextEventType.CONTEXT_CHANGED, this.notifyListeners);
    }

    // Return cleanup function
    return () => {
      this.listeners.delete(callback);

      // Unsubscribe from dataContext if no more listeners
      if (this.listeners.size === 0 && this.isSubscribed) {
        this.isSubscribed = false;
        dataContext.off(ContextEventType.CONTEXT_CHANGED, this.notifyListeners);
      }
    };
  }

  private notifyListeners = () => {
    // Notify all React component subscribers
    this.listeners.forEach((callback) => callback());
  };
}

// Single shared instance
const contextSubscriptionManager = new ContextSubscriptionManager();

/** The `dataContext` fields `useContext()` exposes. */
const CONTEXT_KEYS = [
  'user',
  'workspace',
  'activeEntity',
  'activeEntityTypeId',
  'workspaceTypeId',
  'userTypeId',
  'localUser',
  'cloudUser',
  'currentUser',
  'visitorTypeId',
  'someone',
  'manifests',
  'plugins',
  'project',
  'computeNode',
  'sandboxComputeNode',
  'visitor',
  'bootstrapError',
  'isBootstrapping',
  'cloudApiUrl',
  'cloudLoginAvailable',
  'cloudConnectionStatus',
  'desktopInfo',
  'runtimeKind',
  'isDesktop',
  'version',
  'instanceName',
  'warnings',
  'agenticProcess',
  'agenticProcessTypeId',
  'activeShellId',
  'activeTerminalTargetTypeId',
  'workdir',
  'snifferEnabled',
  'snifferInstalled',
  'snifferReady',
  'terminalRuntimeError',
  'isConnected',
] as const;

type ContextKey = (typeof CONTEXT_KEYS)[number];
export type ContextSnapshot = { [K in ContextKey]: (typeof dataContext)[K] };

const KEY_SET: ReadonlySet<string> = new Set(CONTEXT_KEYS);

// TypeIds are rebuilt on every write: compare them by identity, not reference.
const TYPE_ID_KEYS: ReadonlySet<ContextKey> = new Set([
  'activeEntityTypeId',
  'workspaceTypeId',
  'userTypeId',
  'visitorTypeId',
  'agenticProcessTypeId',
  'activeTerminalTargetTypeId',
]);

function sameValue(key: ContextKey, a: unknown, b: unknown): boolean {
  if (TYPE_ID_KEYS.has(key)) {
    const x = a as { type?: string; id: string } | null | undefined;
    const y = b as { type?: string; id: string } | null | undefined;
    return x?.type === y?.type && x?.id === y?.id;
  }
  if (key === 'terminalRuntimeError') {
    const x = a as (typeof dataContext)['terminalRuntimeError'];
    const y = b as (typeof dataContext)['terminalRuntimeError'];
    return x?.kind === y?.kind && x?.processId === y?.processId;
  }
  return a === b;
}

interface Tracked {
  /** The fields this component has read: the only ones that re-render it. */
  keys: Set<ContextKey>;
  values: Partial<ContextSnapshot>;
  snapshot: ContextSnapshot;
}

/** A read-only view of `values` that records each field read and fills a field on its first read. */
function trackedView(tracked: Tracked, values: Partial<ContextSnapshot>): ContextSnapshot {
  const read = (key: ContextKey) => {
    tracked.keys.add(key);
    if (!(key in values)) (values as Record<string, unknown>)[key] = dataContext[key];
    return values[key];
  };
  return new Proxy({} as ContextSnapshot, {
    get: (_t, key) => (typeof key === 'string' && KEY_SET.has(key) ? read(key as ContextKey) : undefined),
    has: (_t, key) => typeof key === 'string' && KEY_SET.has(key),
    ownKeys: () => [...CONTEXT_KEYS],
    getOwnPropertyDescriptor: (_t, key) =>
      typeof key === 'string' && KEY_SET.has(key)
        ? { value: read(key as ContextKey), enumerable: true, configurable: true, writable: false }
        : undefined,
  });
}

/**
 * Hook to access dataContext reactively using useSyncExternalStore.
 *
 * A component re-renders only when a field IT READ changes: the snapshot records
 * which fields the component touched (destructuring counts) and `getSnapshot`
 * compares just those. A tab switch writes the active shell, process and workdir;
 * the dock chrome that reads only the user or the compute node no longer
 * re-renders for it, and no consumer re-reads all ~40 getters on every write.
 */
export function useContext(): ContextSnapshot {
  const trackedRef = useRef<Tracked | null>(null);
  if (!trackedRef.current) {
    const tracked = { keys: new Set<ContextKey>(), values: {} } as Tracked;
    tracked.snapshot = trackedView(tracked, tracked.values);
    trackedRef.current = tracked;
  }

  // Subscribe to dataContext changes using the shared subscription manager
  // This ensures only ONE listener on the EventEmitter, regardless of how many components use this hook
  const subscribe = useCallback((callback: () => void) => {
    return contextSubscriptionManager.subscribe(callback);
  }, []);

  const getSnapshot = useCallback(() => {
    const tracked = trackedRef.current!;
    let changed = false;
    for (const key of tracked.keys) {
      if (!sameValue(key, tracked.values[key], dataContext[key])) {
        changed = true;
        break;
      }
    }
    if (changed) {
      // A new object only when a field this component reads changed: a stable
      // reference is what keeps useSyncExternalStore from re-rendering.
      const values: Partial<ContextSnapshot> = {};
      for (const key of tracked.keys) (values as Record<string, unknown>)[key] = dataContext[key];
      tracked.values = values;
      tracked.snapshot = trackedView(tracked, values);
    }
    return tracked.snapshot;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
