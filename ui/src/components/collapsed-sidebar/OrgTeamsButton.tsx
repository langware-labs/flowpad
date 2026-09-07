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
 * the dev-mode button next to it.
 *
 * Carries `data-testid`, NOT `data-rail-item`: that attribute is the rail's
 * identity, emitted only from the two spec-driven loops, and
 * `tests/react/rail-order-and-gates.test.tsx` collects every one of them to
 * assert the exact rail order. A cluster button wearing it would join a contract
 * it is deliberately outside. The sibling buttons use test ids for the same reason.
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
      // `bg-accent`, matching FlowpadAssistantButton beside it — the cluster's
      // pressed state, not the `bg-sidebar-accent` the menu-shaped rail uses.
      className={cn('h-8 w-8', isActive && 'bg-accent text-accent-foreground')}
      data-testid="org-teams-button"
      onClick={() => navigation.openTab(ViewType.ORGANIZATION)}
      title={t`Org & teams`}
    >
      <Building2 className="h-4 w-4" />
    </Button>
  );
}
