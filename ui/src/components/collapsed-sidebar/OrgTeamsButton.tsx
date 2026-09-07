import { Building2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';
import { useHasOrgOrTeam } from '@src/hooks/use-has-org-or-team';
import { cn } from '@src/lib/utils';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';

/**
 * Org & teams — account-cluster button at the foot of the rail, beside the theme
 * toggle and user menu, not a `RAIL_ITEMS` mode-matrix entry. Self-gating like
 * the dev-mode button next to it: renders nothing unless `useHasOrgOrTeam()`.
 * Opens `ViewType.ORGANIZATION`, the same page the hub rail's entry opens.
 */
export function OrgTeamsButton() {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const show = useHasOrgOrTeam();

  if (!show) return null;

  const isActive = currentDock?.viewType === ViewType.ORGANIZATION;

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('h-8 w-8', isActive && 'bg-sidebar-accent text-sidebar-accent-foreground')}
      data-rail-item="org-teams"
      onClick={() => navigation.openTab(ViewType.ORGANIZATION)}
      title={t`Org & teams`}
    >
      <Building2 className="h-4 w-4" />
    </Button>
  );
}
