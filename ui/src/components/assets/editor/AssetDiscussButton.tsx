import { MessageSquare } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { CompactIconAction } from '@src/components/entity-actions/CompactIconAction';
import { isContentAssetDock } from '@src/navigation/content-asset-dock';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { tabForDockKey, TabLifecycleState } from '@sdk';
import { useAllTabs, useTabLifecycle } from '@src/tabs/use-tab-manager';

export function DiscussInVibeButton({
  dock,
  projectId,
  navigation,
  disabled = false,
  loading = false,
}: {
  dock: DockPointer;
  /** The project the Vibe session belongs to (the asset tab's project). */
  projectId: string | null;
  navigation: Pick<NavigationActions, 'discussAsset'>;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { t } = useLingui();
  const label = t`Discuss`;
  const tooltip = loading
    ? t`Finishing asset load…`
    : disabled
      ? t`Select a project to discuss this file`
      : label;

  return (
    <CompactIconAction
      icon={MessageSquare}
      label={tooltip}
      disabled={disabled}
      onClick={() => {
        if (projectId) void navigation.discussAsset(dock, projectId);
      }}
      testId="asset-discuss-in-vibe"
    />
  );
}

/**
 * Asset-header action: discuss this asset in a Vibe HOST tab, the asset as its
 * child (`navigation.discussAsset` — resumes the last chat about it). Offered on
 * every surface, the same icon working the same way; hidden only once the asset
 * already has its chat beside it (it is a host's child).
 */
export function AssetDiscussButton() {
  const { currentDock, navigation, windowMode } = useDockNavigation();
  const allTabs = useAllTabs();
  const lifecycle = useTabLifecycle(currentDock?.tabHash);

  if (
    !currentDock ||
    !isContentAssetDock(currentDock) ||
    !!currentDock.hostProcessId ||
    windowMode
  ) {
    return null;
  }

  const projectId = tabForDockKey(allTabs, currentDock.tabHash)?.project_id ?? null;
  const loading = lifecycle?.state === TabLifecycleState.Opening;
  const disabled = !projectId || loading;
  return (
    <DiscussInVibeButton
      dock={currentDock}
      projectId={projectId}
      navigation={navigation}
      disabled={disabled}
      loading={loading}
    />
  );
}
