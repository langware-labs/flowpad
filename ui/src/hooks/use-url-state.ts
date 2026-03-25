import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router';

// Define the shape of your URL-persisted state
interface UrlState {
  // UI state
  activeTab?: string;
  sidebarOpen?: boolean;
  viewMode?: 'chat' | 'code' | 'split';

  // Chat state
  messageId?: string;
  threadId?: string;

  // Editor state
  selectedFile?: string;
  lineNumber?: number;

  // Filter/search state
  searchQuery?: string;
  filters?: Record<string, string>;
}

// Define serialization/deserialization for complex types
const stateSerializers = {
  filters: {
    serialize: (value: Record<string, string>) => JSON.stringify(value),
    deserialize: (value: string) => JSON.parse(value),
  },
  sidebarOpen: {
    serialize: (value: boolean) => value.toString(),
    deserialize: (value: string) => value === 'true',
  },
  lineNumber: {
    serialize: (value: number) => value.toString(),
    deserialize: (value: string) => parseInt(value, 10),
  },
};

// Create the URL state store
interface UrlStateStore extends UrlState {
  setUrlState: (updates: Partial<UrlState>) => void;
  resetUrlState: () => void;
}

export const useUrlStateStore = create<UrlStateStore>()(
  subscribeWithSelector((set) => ({
    // Default values
    viewMode: 'chat',
    sidebarOpen: true,

    setUrlState: (updates) => set((state) => ({ ...state, ...updates })),
    resetUrlState: () => set(() => ({})),
  })),
);

// Custom hook to sync URL with store
export function useUrlState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const store = useUrlStateStore();

  // Initialize store from URL on mount
  useEffect(() => {
    const urlState: Partial<UrlState> = {};

    // Parse each URL param
    searchParams.forEach((value, key) => {
      if (key in stateSerializers) {
        // Use custom deserializer if available
        urlState[key as keyof UrlState] = stateSerializers[key as keyof typeof stateSerializers].deserialize(value);
      } else {
        // Default to string value
        (urlState as Record<string, unknown>)[key] = value;
      }
    });

    // Update store with URL state
    store.setUrlState(urlState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  // Subscribe to store changes and update URL
  useEffect(() => {
    const unsubscribe = useUrlStateStore.subscribe(
      (state) => state,
      (newState) => {
        // Build new search params from state
        const newParams = new URLSearchParams();

        Object.entries(newState).forEach(([key, value]) => {
          // Skip functions and undefined values
          if (typeof value === 'function' || value === undefined) return;

          if (key in stateSerializers) {
            // Use custom serializer if available
            const serializerKey = key as keyof typeof stateSerializers;

            // Type-safe serialization based on the key
            if (serializerKey === 'filters' && typeof value === 'object' && value !== null) {
              newParams.set(key, stateSerializers.filters.serialize(value as Record<string, string>));
            } else if (serializerKey === 'sidebarOpen' && typeof value === 'boolean') {
              newParams.set(key, stateSerializers.sidebarOpen.serialize(value));
            } else if (serializerKey === 'lineNumber' && typeof value === 'number') {
              newParams.set(key, stateSerializers.lineNumber.serialize(value));
            }
          } else if (value !== null && value !== '') {
            // Default to string conversion
            newParams.set(key, String(value));
          }
        });

        // Update URL without triggering navigation
        setSearchParams(newParams, { replace: true });
      },
    );

    return unsubscribe;
  }, [setSearchParams]);

  // Helper to update both store and URL
  const setState = useCallback(
    (updates: Partial<UrlState>) => {
      store.setUrlState(updates);
    },
    [store],
  );

  // Helper to get a specific value with type safety
  const getValue = useCallback(
    <K extends keyof UrlState>(key: K): UrlState[K] => {
      return store[key];
    },
    [store],
  );

  // Helper to clear specific keys
  const clearKeys = useCallback(
    (keys: (keyof UrlState)[]) => {
      const updates: Partial<UrlState> = {};
      keys.forEach((key) => {
        updates[key] = undefined;
      });
      store.setUrlState(updates);
    },
    [store],
  );

  return {
    state: store,
    setState,
    getValue,
    clearKeys,
    searchParams,
  };
}

// Helper hook for specific state slices
export function useUrlParam<K extends keyof UrlState>(key: K) {
  const { state, setState } = useUrlState();

  const value = state[key];
  const setValue = useCallback(
    (newValue: UrlState[K]) => {
      setState({ [key]: newValue } as Partial<UrlState>);
    },
    [key, setState],
  );

  return [value, setValue] as const;
}
