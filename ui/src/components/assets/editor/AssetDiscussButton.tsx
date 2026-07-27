import { MessageSquare } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { ViewMode, useIsVibe } from '@src/contexts/view-mode-context';
import { isContentAssetDock } from '@src/navigation/content-asset-dock';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useAllTabs } from '@src/tabs/all-tabs-store';
import { TabLifecycleState, useTabLifecycle } from '@src/tabs/tab-lifecycle';

export function DiscussInVibeButton({
  dock,
  navigation,
  disabled = false,
  loading = false,
}: {
  dock: DockPointer;
  navigation: Pick<NavigationActions, 'openDock'>;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { t } = useLingui();
  const label = t`Discuss`;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 gap-1.5 rounded-full px-2.5"
      disabled={disabled}
      onClick={() => navigation.openDock(dock.withViewMode(ViewMode.Vibe))}
      aria-label={label}
      title={
        loading
          ? t`Finishing asset load…`
          : disabled
            ? t`Select a project to discuss this file`
            : label
      }
      data-testid="asset-discuss-in-vibe"
    >
      <MessageSquare className="h-3.5 w-3.5" />
      <span>{label}</span>
    </Button>
  );
}

/**
 * Asset-header action for entering the target's Vibe workspace.
 *
 * Navigation remains URL-first: the click changes only `viewMode`; the route
 * loader and mounted workspace own every resulting context/session change.
 */
export function AssetDiscussButton() {
  const { currentDock, navigation, windowMode } = useDockNavigation();
  const isVibe = useIsVibe();
  const allTabs = useAllTabs();
  const lifecycle = useTabLifecycle(currentDock?.tabHash);

  if (
    !currentDock ||
    !isContentAssetDock(currentDock) ||
    isVibe ||
    windowMode
  ) {
    return null;
  }

  const projectId =
    allTabs.find((tab) => tab.dockPointer?.tabHash === currentDock.tabHash)
      ?.project_id ?? null;
  const loading = lifecycle?.state === TabLifecycleState.Opening;
  const disabled = !projectId || loading;
  return (
    <DiscussInVibeButton
      dock={currentDock}
      navigation={navigation}
      disabled={disabled}
      loading={loading}
    />
  );
}
