import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCallback, useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { toplog } from '@sdk';

// Browser history entry with metadata
interface HistoryEntry {
  pathname: string;
  search: string;
  state: unknown;
  timestamp: number;
  title?: string;
}

// Navigation state store with history tracking
interface NavigationStore {
  // History management
  history: HistoryEntry[];
  currentIndex: number;

  // Navigation state
  previousPath: string | null;
  isNavigatingBack: boolean;

  // Actions
  pushHistory: (entry: HistoryEntry) => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  clearHistory: () => void;
}

const useNavigationStore = create<NavigationStore>()(
  persist(
    (set, get) => ({
      history: [],
      currentIndex: -1,
      previousPath: null,
      isNavigatingBack: false,

      pushHistory: (entry) =>
        set((state) => {
          // Remove any forward history when pushing new entry
          const newHistory = [...state.history.slice(0, state.currentIndex + 1), entry];
          toplog.log('navigation', 'store.pushHistory', {
            path: entry.pathname + entry.search,
            prevIndex: state.currentIndex,
            newIndex: newHistory.length - 1,
            len: newHistory.length,
          });
          return {
            history: newHistory.slice(-50), // Keep last 50 entries
            currentIndex: newHistory.length - 1,
            previousPath: state.history[state.currentIndex]?.pathname || null,
          };
        }),

      goBack: () =>
        set((state) => {
          toplog.log('navigation', 'store.goBack', {
            fromIndex: state.currentIndex,
            toIndex: Math.max(0, state.currentIndex - 1),
            target: state.history[Math.max(0, state.currentIndex - 1)]?.pathname,
          });
          return {
            currentIndex: Math.max(0, state.currentIndex - 1),
            isNavigatingBack: true,
          };
        }),

      goForward: () =>
        set((state) => {
          toplog.log('navigation', 'store.goForward', {
            fromIndex: state.currentIndex,
            toIndex: Math.min(state.history.length - 1, state.currentIndex + 1),
          });
          return {
            currentIndex: Math.min(state.history.length - 1, state.currentIndex + 1),
            isNavigatingBack: false,
          };
        }),

      canGoBack: () => get().currentIndex > 0,
      canGoForward: () => get().currentIndex < get().history.length - 1,

      clearHistory: () =>
        set(() => ({
          history: [],
          currentIndex: -1,
          previousPath: null,
        })),
    }),
    {
      name: 'navigation-history',
      partialize: (state) => ({
        history: state.history.slice(-10), // Only persist last 10 entries
      }),
    },
  ),
);

// Deep linking configuration
interface DeepLinkConfig {
  // Map of route patterns to state extractors
  routes: Record<string, (params: Record<string, string | undefined>, search: URLSearchParams) => unknown>;

  // Map of state to URL builders
  builders: Record<string, (state: Record<string, unknown>) => { path: string; search?: string }>;
}

// Hook for managing navigation with deep linking
export function useNavigationState(config?: DeepLinkConfig) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const store = useNavigationStore();

  // Track location changes
  useEffect(() => {
    const entry: HistoryEntry = {
      pathname: location.pathname,
      search: location.search,
      state: location.state,
      timestamp: Date.now(),
    };

    // Don't push if we're navigating through history
    if (!store.isNavigatingBack) {
      store.pushHistory(entry);
    } else {
      toplog.log('navigation', 'location change while isNavigatingBack — skip push, reset flag', {
        path: entry.pathname + entry.search,
      });
      // Reset the flag so the next forward navigation is tracked
      useNavigationStore.setState({ isNavigatingBack: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  // Extract state from current URL using config
  const currentState = useMemo(() => {
    if (!config) return null;

    const searchParams = new URLSearchParams(location.search);

    // Find matching route pattern
    for (const [pattern, extractor] of Object.entries(config.routes)) {
      // Simple pattern matching (you could use path-to-regexp for complex patterns)
      if (location.pathname.includes(pattern)) {
        return extractor(params, searchParams);
      }
    }

    return null;
  }, [location, params, config]);

  // Navigate with state persistence
  const navigateWithState = useCallback(
    (stateName: string, state: Record<string, unknown>, options?: { replace?: boolean }) => {
      if (!config?.builders[stateName]) {
        console.warn(`No builder configured for state: ${stateName}`);
        return;
      }

      const { path, search } = config.builders[stateName](state);
      const url = search ? `${path}?${search}` : path;

      void navigate(url, {
        replace: options?.replace,
        state: { ...state, _source: stateName },
      });
    },
    [navigate, config],
  );

  // Build shareable URL for current state
  const getShareableUrl = useCallback(() => {
    const baseUrl = window.location.origin;
    const path = location.pathname + location.search;
    return `${baseUrl}${path}`;
  }, [location]);

  // Copy shareable URL to clipboard
  const copyShareableUrl = useCallback(async () => {
    const url = getShareableUrl();
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch (error) {
      console.error('Failed to copy URL:', error);
      return false;
    }
  }, [getShareableUrl]);

  return {
    // Current state
    currentState,
    location,
    params,

    // Navigation
    navigateWithState,
    goBack: () => {
      const can = store.canGoBack();
      // NOTE: this drives TWO stacks at once — the zustand store (store.goBack)
      // AND the browser/router history (navigate(-1)). If both advance, a single
      // "back" click steps back twice. The store/popstate trace lines around this
      // one reveal whether that is what's happening.
      toplog.log('navigation', 'useNavigationState.goBack', {
        canGoBack: can,
        url: location.pathname + location.search,
      });
      if (can) {
        store.goBack();
        void navigate(-1);
      }
    },
    goForward: () => {
      const can = store.canGoForward();
      toplog.log('navigation', 'useNavigationState.goForward', {
        canGoForward: can,
        url: location.pathname + location.search,
      });
      if (can) {
        store.goForward();
        void navigate(1);
      }
    },

    // History
    history: store.history,
    canGoBack: store.canGoBack(),
    canGoForward: store.canGoForward(),

    // Sharing
    getShareableUrl,
    copyShareableUrl,
  };
}

// Example configuration for agent/flow routes
export const agentFlowDeepLinkConfig: DeepLinkConfig = {
  routes: {
    '/agent': (params, search) => ({
      agentId: params.agentId,
      processId: params.processId,
      messageId: search.get('message'),
      viewMode: search.get('view') || 'chat',
      filters: search.get('filters') ? JSON.parse(search.get('filters')!) : {},
    }),
  },
  builders: {
    flow: (state) => {
      const agentId = typeof state.agentId === 'string' ? state.agentId : '';
      const processId = typeof state.processId === 'string' ? state.processId : '';
      const messageId = typeof state.messageId === 'string' ? state.messageId : undefined;
      const viewMode = typeof state.viewMode === 'string' ? state.viewMode : undefined;
      const filters = state.filters && typeof state.filters === 'object' ? state.filters : undefined;

      return {
        path: `/agent/${agentId}/flow/${processId}`,
        search: new URLSearchParams({
          ...(messageId && { message: messageId }),
          ...(viewMode && { view: viewMode }),
          ...(filters && { filters: JSON.stringify(filters) }),
        }).toString(),
      };
    },
    agent: (state) => {
      const agentId = typeof state.agentId === 'string' ? state.agentId : '';
      const viewMode = typeof state.viewMode === 'string' ? state.viewMode : undefined;

      return {
        path: `/agent/${agentId}`,
        search: viewMode ? `view=${viewMode}` : undefined,
      };
    },
  },
};
