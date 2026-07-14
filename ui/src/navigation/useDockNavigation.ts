import { Layout } from '@sdk';
import { defineGlobal } from '@sdk/utils';
import { useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ViewType } from '@src/types/ViewType';
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
/**
 * Read-only selector for the current dock pointer parsed from the URL. Prefer this
 * over the full {@link useDockNavigation} when a component only needs to know *what*
 * is shown (e.g. which view type) and never navigates — it skips building a
 * NavigationActions instance and rewriting the `navigation` global on every URL change.
 */
export function useCurrentDock(): DockPointer | null {
  const location = useLocation();
  const params = useParams<{ viewType?: string }>();

  return useMemo(() => {
    if (params.viewType) {
      try {
        return DockPointer.fromUrl(`${location.pathname}${location.search}`);
      } catch (error) {
        console.warn('[useDockNavigation] Invalid URL, returning default dock:', error);
        // Return default dock pointer for invalid URLs
        return new DockPointer();
      }
    }
    return null;
  }, [location.pathname, location.search, params.viewType]);
}

/**
 * True when the current URL is a vibe *home* surface — the bare home (no dock
 * URL) or the HOME view (incl. the `vibeNoProcess` landing) — as opposed to a
 * vibe workspace or any other dock. This is the single predicate for "is there
 * no active session here worth preserving": consumed by `flow-page` to pick the
 * home hero and by the project-open flow to decide whether switching a project
 * should resume its last build process (it shouldn't, on home).
 */
export function useIsVibeHome(): boolean {
  const currentDock = useCurrentDock();
  return currentDock === null || currentDock.viewType === ViewType.HOME;
}

export function useDockNavigation(): UseDockNavigationReturn {
  const navigate = useNavigate();
  const location = useLocation();
  const currentDock = useCurrentDock();

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
