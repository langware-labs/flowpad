import { AppWindow } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { CompactIconAction } from '@src/components/entity-actions/CompactIconAction';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * Pop the addressed view out into its own window — the tab strip's per-chip
 * gesture, made global. Delegates to `navigation.openDockInWindow`
 * (docs/tab-management.md Part 3 §7); the origin window stays put.
 *
 * Self-gating like `AssetDiscussButton`: only for a dock the strip would show
 * a chip for (`isDockUrl`), and never inside a window that already is a popout.
 */
export function OpenInWindowButton() {
  const { t } = useLingui();
  const { currentDock, navigation, isDockUrl, windowMode } = useDockNavigation();

  if (!currentDock || !isDockUrl || windowMode) return null;

  return (
    <CompactIconAction
      icon={AppWindow}
      label={t`Open in new window`}
      onClick={() => navigation.openDockInWindow(currentDock)}
      testId="top-nav-open-in-window"
    />
  );
}
