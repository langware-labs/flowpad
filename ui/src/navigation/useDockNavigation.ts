import { Layout } from '@sdk';
import { defineGlobal } from '@sdk/utils';
import { useMemo } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { DockPointer } from './DockPointer';
import { NavigationActions } from './NavigationActions';
import { detectLayout } from './url-builder';

export interface UseDockNavigationReturn {
  /** Navigation actions instance */
  navigation: NavigationActions;

  /** Whether current URL is a dock URL */
  isDockUrl: boolean;

  /** Current dock pointer parsed from URL (null if not a dock URL) */
  currentDock: DockPointer | null;

  /**
   * True when the current URL is a `win/` focus-window URL
   * (docs/tab-management.md Part 3 §7). Derived read-only from the URL —
   * exactly like the `/dev/` detection above it. Nothing ever SETS window
   * mode; you navigate into it (deep-link and refresh work for free).
   */
  windowMode: boolean;
}

/**
 * Hook to access dock navigation functionality
 *
 * Returns navigation instance and current dock state from URL
 *
 * Uses relative navigation: NavigationActions reads current URL and replaces dock portion.
 * No need to track agentId/processId - they're preserved from the current URL.
 *
 * Usage:
 * ```tsx
 * const { navigation, isDockUrl, currentDock } = useDockNavigation();
 *
 * // Open a tab
 * navigation.openTab(ViewType.EDITOR);
 *
 * // Check if we're in a dock URL
 * if (isDockUrl) {
 *   console.log('Current dock:', currentDock?.viewType, currentDock?.pointer);
 * }
 * ```
 */
export function useDockNavigation(): UseDockNavigationReturn {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ agentId: string; processId: string; viewType?: string; pointer?: string; '*'?: string }>();
  const [searchParams] = useSearchParams();

  // Parse current dock state from URL
  const currentDock = useMemo(() => {
    if (params.viewType) {
      try {
        // Detect layout from URL path (keyword→Layout table in url-builder)
        const layout = detectLayout(location.pathname);

        // Use pointer from URL params - check both :pointer param and * wildcard
        // For routes like /:viewType/:pointer, params.pointer is used
        // For routes like /:viewType/*, params["*"] captures the remaining path
        const pointer = params.pointer || params['*'];
        return DockPointer.fromUrl(params.viewType, pointer, searchParams, layout);
      } catch (error) {
        console.warn('[useDockNavigation] Invalid URL, returning default dock:', error);
        // Return default dock pointer for invalid URLs
        return new DockPointer();
      }
    }
    return null;
  }, [location.pathname, params.viewType, params.pointer, searchParams]);

  // Create navigation instance with currentDock so openDock() can deduplicate
  const navigation = useMemo(() => {
    const actions = new NavigationActions(navigate, currentDock);
    defineGlobal('navigation', actions);
    return actions;
  }, [navigate, currentDock]);

  const isDockUrl = currentDock !== null;

  // URL-derived, read-only (Part 3 §7): the focus-window layout is a property
  // of the URL, never of component state.
  const windowMode = detectLayout(location.pathname) === Layout.WIN;

  return {
    navigation,
    isDockUrl,
    currentDock,
    windowMode,
  };
}
