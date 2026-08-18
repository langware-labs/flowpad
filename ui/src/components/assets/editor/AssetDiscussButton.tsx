import { MessageSquare } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { compactEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { ViewMode, useIsVibe } from '@src/contexts/view-mode-context';
import { isContentAssetDock } from '@src/navigation/content-asset-dock';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { tabForDockKey, TabLifecycleState } from '@sdk';
import { useAllTabs, useTabLifecycle } from '@src/tabs/use-tab-manager';

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
  const tooltip = loading
    ? t`Finishing asset load…`
    : disabled
      ? t`Select a project to discuss this file`
      : label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={compactEntityActionClassName}
            disabled={disabled}
            onClick={() => navigation.openDock(dock.withViewMode(ViewMode.Vibe))}
            aria-label={tooltip}
            data-testid="asset-discuss-in-vibe"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
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

  const projectId = tabForDockKey(allTabs, currentDock.tabHash)?.project_id ?? null;
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
