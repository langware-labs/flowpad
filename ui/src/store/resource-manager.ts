/**
 * Resource Manager Store for lazy loading system profile resources.
 *
 * Provides cache-first strategy with time window support for incremental scanning.
 */

import { ActionInfo, dataManager, type SystemProfileItem } from '@sdk';
import { create } from 'zustand';

// ─────────────────────────────────────────────────────────────────
// Resource Type Helpers
// ─────────────────────────────────────────────────────────────────

const SYSTEM_RESOURCE_PREFIX = 'system_resource_claude_';

/**
 * Convert simple name to full resource type with prefix.
 * @example getSystemResourceType('hook') → 'system_resource_claude_hook'
 */
export function getSystemResourceType(simpleName: string): string {
  return `${SYSTEM_RESOURCE_PREFIX}${simpleName}`;
}

/**
 * Extract simple name from full resource type.
 * @example getSimpleResourceType('system_resource_claude_hook') → 'hook'
 */
export function getSimpleResourceType(fullType: string): string {
  if (fullType.startsWith(SYSTEM_RESOURCE_PREFIX)) {
    return fullType.slice(SYSTEM_RESOURCE_PREFIX.length);
  }
  return fullType;
}

/**
 * Check if a type is a system resource type.
 */
export function isSystemResourceType(type: string): boolean {
  return type.startsWith(SYSTEM_RESOURCE_PREFIX);
}

/**
 * Enum of all system resource types (prefixed)
 */
export const SystemResourceType = {
  HOOK: getSystemResourceType('hook'),
  MCP_SERVER: getSystemResourceType('mcp_server'),
  PLUGIN: getSystemResourceType('plugin'),
  MARKETPLACE: getSystemResourceType('marketplace'),
  COMMAND: getSystemResourceType('command'),
  AGENT: getSystemResourceType('agent'),
  SKILL: getSystemResourceType('skill'),
  PROJECT: getSystemResourceType('project'),
  SESSION: getSystemResourceType('claude_session'),
  PLAN: getSystemResourceType('plan'),
  TODO_FILE: getSystemResourceType('todo_file'),
  TODO: getSystemResourceType('todo_file'), // Alias for TODO_FILE
  CLAUDE_MD: getSystemResourceType('claude_md'),
  DIRECTORY: getSystemResourceType('directory'),
  GITHUB_REPO: getSystemResourceType('github_repo'),
  IDE_CONNECTION: getSystemResourceType('ide_connection'),
} as const;

export type SystemResourceTypeValue = (typeof SystemResourceType)[keyof typeof SystemResourceType];

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface TimeWindow {
  start?: string; // ISO timestamp
  end?: string; // ISO timestamp
}

export interface ScanParams {
  timeWindow?: TimeWindow;
  parentId?: string;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}

export interface ScanResult<T = SystemProfileItem> {
  items: T[];
  scannedWindow: TimeWindow;
  totalCount: number;
  hasMore: boolean;
  resourceType: string;
}

interface CacheEntry<T = SystemProfileItem> {
  items: T[];
  windows: TimeWindow[]; // Which time ranges are cached
  lastFullScan: number | null; // Timestamp of last full scan
  byId: Map<string, T>; // Fast lookup by id
  byParent: Map<string, T[]>; // Grouped by parent_id
}

// ─────────────────────────────────────────────────────────────────
// Store State
// ─────────────────────────────────────────────────────────────────

interface ResourceManagerState {
  // State
  cache: Map<string, CacheEntry>;
  computeNodeId: string | null;
  isLoading: Map<string, boolean>;
  errors: Map<string, string | null>;

  // Actions
  setComputeNodeId: (id: string) => void;
  getResources: <T extends SystemProfileItem>(resourceType: string, params?: ScanParams) => Promise<T[]>;
  invalidate: (resourceType?: string, itemId?: string) => void;
  getCachedResources: <T extends SystemProfileItem>(
    resourceType: string,
    timeWindow?: TimeWindow,
    parentId?: string,
  ) => T[] | null;
  getLoadingState: (resourceType: string) => boolean;
  getError: (resourceType: string) => string | null;
}

// ─────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────

function getParentId(item: SystemProfileItem): string | undefined {
  // Type-specific parent extraction. Sessions group by cwd (path is the
  // natural project key now that `project_encoded_name` is no longer carried
  // on Flow records); todos group by their session_id.
  const anyItem = item as unknown as Record<string, unknown>;
  if ('cwd' in anyItem && anyItem.cwd) return anyItem.cwd as string;
  if ('session_id' in anyItem) return anyItem.session_id as string;
  return undefined;
}

function isInTimeWindow(modifiedAt: string | undefined, window: TimeWindow): boolean {
  if (!modifiedAt) return false;
  if (window.start && modifiedAt < window.start) return false;
  if (window.end && modifiedAt > window.end) return false;
  return true;
}

function isWindowCovered(cached: TimeWindow[], requested: TimeWindow): boolean {
  // Simple check: is there a cached window that fully covers the requested?
  return cached.some((w) => {
    const startOk = !requested.start || (w.start && w.start <= requested.start);
    const endOk = !requested.end || (w.end && w.end >= requested.end);
    return startOk && endOk;
  });
}

function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  if (!a.end || !b.start) return true;
  return a.end >= b.start;
}

function maxDate(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function mergeOverlappingWindows(windows: TimeWindow[]): TimeWindow[] {
  const sorted = windows.filter((w) => w.start || w.end).sort((a, b) => ((a.start || '') > (b.start || '') ? 1 : -1));

  const merged: TimeWindow[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && windowsOverlap(last, w)) {
      last.end = maxDate(last.end, w.end);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────

// Track pending requests to avoid duplicates
const pendingRequests = new Map<string, Promise<ScanResult>>();

function getRequestKey(resourceType: string, params: ScanParams): string {
  return JSON.stringify({ resourceType, ...params });
}

export const useResourceManager = create<ResourceManagerState>()((set, get) => ({
  cache: new Map(),
  computeNodeId: null,
  isLoading: new Map(),
  errors: new Map(),

  setComputeNodeId: (id: string) => {
    set({ computeNodeId: id });
  },

  getLoadingState: (resourceType: string) => {
    return get().isLoading.get(resourceType) ?? false;
  },

  getError: (resourceType: string) => {
    return get().errors.get(resourceType) ?? null;
  },

  getCachedResources: <T extends SystemProfileItem>(
    resourceType: string,
    timeWindow?: TimeWindow,
    parentId?: string,
  ): T[] | null => {
    const state = get();
    const entry = state.cache.get(resourceType);
    if (!entry) return null;

    // Check if time window is covered by cached windows
    if (timeWindow && !isWindowCovered(entry.windows, timeWindow)) {
      return null;
    }

    // Full scan available and no time window requested
    if (!timeWindow && entry.lastFullScan) {
      let items = entry.items;
      if (parentId) {
        items = entry.byParent.get(parentId) || [];
      }
      return items as T[];
    }

    // Filter by time window
    let items = entry.items;
    if (timeWindow) {
      items = items.filter((item) => isInTimeWindow(item.modified_at, timeWindow));
    }
    if (parentId) {
      items = items.filter((item) => getParentId(item) === parentId);
    }

    return items as T[];
  },

  getResources: async <T extends SystemProfileItem>(resourceType: string, params: ScanParams = {}): Promise<T[]> => {
    const state = get();
    const { timeWindow, parentId, limit = 100, offset = 0, forceRefresh = false } = params;

    // Check cache first (unless forceRefresh)
    if (!forceRefresh) {
      const cached = state.getCachedResources<T>(resourceType, timeWindow, parentId);
      if (cached !== null) {
        return cached;
      }
    }

    // Deduplicate concurrent requests
    const requestKey = getRequestKey(resourceType, params);
    const pendingRequest = pendingRequests.get(requestKey);
    if (pendingRequest) {
      const result = await pendingRequest;
      return result.items as T[];
    }

    if (!state.computeNodeId) {
      throw new Error('ComputeNode ID not set');
    }

    // Set loading state
    set((s) => ({
      isLoading: new Map(s.isLoading).set(resourceType, true),
      errors: new Map(s.errors).set(resourceType, null),
    }));

    // Create fetch promise
    const fetchPromise = (async (): Promise<ScanResult> => {
      try {
        const actionInfo = new ActionInfo('scan-resources', 'compute_node', state.computeNodeId, 'GET');

        const queryParams: Record<string, string> = { type: resourceType };
        if (timeWindow?.start) queryParams.time_start = timeWindow.start;
        if (timeWindow?.end) queryParams.time_end = timeWindow.end;
        if (parentId) queryParams.parent_id = parentId;
        if (limit) queryParams.limit = String(limit);
        if (offset) queryParams.offset = String(offset);

        actionInfo.queryParameters = queryParams;

        const result = await dataManager.callAction<void, ScanResult<T>>(actionInfo);

        // Validate response has expected structure
        if (!result || !Array.isArray(result.items)) {
          // Return empty result if response doesn't match expected format
          // This handles cases where the backend endpoint isn't implemented yet
          return {
            items: [],
            scannedWindow: timeWindow || {},
            totalCount: 0,
            hasMore: false,
            resourceType,
          };
        }

        return result;
      } finally {
        // Clear loading state
        set((s) => ({
          isLoading: new Map(s.isLoading).set(resourceType, false),
        }));
        pendingRequests.delete(requestKey);
      }
    })();

    pendingRequests.set(requestKey, fetchPromise);

    try {
      const result = await fetchPromise;

      // Merge into cache
      set((s) => {
        const newCache = new Map(s.cache);
        let entry = newCache.get(resourceType);
        if (!entry) {
          entry = {
            items: [],
            windows: [],
            lastFullScan: null,
            byId: new Map(),
            byParent: new Map(),
          };
          newCache.set(resourceType, entry);
        }

        // Merge items (newer wins on conflict)
        for (const item of result.items) {
          const existingItem = entry.byId.get(item.id);
          if (!existingItem || (item.modified_at || '') > (existingItem.modified_at || '')) {
            // Remove old from lists
            if (existingItem) {
              entry.items = entry.items.filter((i) => i.id !== item.id);
            }
            // Add new
            entry.items.push(item);
            entry.byId.set(item.id, item);

            // Update parent index
            const itemParentId = getParentId(item);
            if (itemParentId) {
              const parentItems = entry.byParent.get(itemParentId) || [];
              entry.byParent.set(itemParentId, [...parentItems.filter((i) => i.id !== item.id), item]);
            }
          }
        }

        // Track covered time windows
        if (timeWindow) {
          entry.windows.push(timeWindow);
          entry.windows = mergeOverlappingWindows(entry.windows);
        } else if (!result.hasMore) {
          // Only mark as full scan if we got ALL items (hasMore: false)
          // Limited scans (e.g., limit=5) should NOT set lastFullScan
          entry.lastFullScan = Date.now();
        }

        return { cache: newCache };
      });

      return result.items as T[];
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch resources';
      set((s) => ({
        errors: new Map(s.errors).set(resourceType, errorMessage),
      }));
      throw err;
    }
  },

  invalidate: (resourceType?: string, itemId?: string) => {
    set((s) => {
      const newCache = new Map(s.cache);

      if (!resourceType) {
        // Clear all cache
        newCache.clear();
      } else {
        const entry = newCache.get(resourceType);
        if (entry) {
          if (itemId) {
            // Invalidate specific item
            entry.items = entry.items.filter((i) => i.id !== itemId);
            entry.byId.delete(itemId);
            // Clear windows since we have a gap now
            entry.windows = [];
            entry.lastFullScan = null;
          } else {
            // Invalidate entire type
            newCache.delete(resourceType);
          }
        }
      }

      return { cache: newCache };
    });
  },
}));

// ─────────────────────────────────────────────────────────────────
// Singleton instance for non-React usage
// ─────────────────────────────────────────────────────────────────

export const resourceManager = {
  setComputeNodeId: (id: string) => useResourceManager.getState().setComputeNodeId(id),
  getResources: <T extends SystemProfileItem>(resourceType: string, params?: ScanParams) =>
    useResourceManager.getState().getResources<T>(resourceType, params),
  invalidate: (resourceType?: string, itemId?: string) =>
    useResourceManager.getState().invalidate(resourceType, itemId),
  getCachedResources: <T extends SystemProfileItem>(resourceType: string, timeWindow?: TimeWindow, parentId?: string) =>
    useResourceManager.getState().getCachedResources<T>(resourceType, timeWindow, parentId),
};
