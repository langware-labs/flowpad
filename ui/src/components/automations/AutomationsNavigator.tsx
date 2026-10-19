/**
 * The Automations navigator: the three places, with what needs attention.
 * Active place comes from the URL (`currentDock`), clicks only navigate.
 */
import { Trans } from '@lingui/react/macro';
import { History, ListChecks, Radio } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAutomations } from '@src/hooks/automations/useAutomations';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { parseAutomationsRoute, type AutomationsPlace } from './automations-pointer';

export function AutomationsNavigator() {
  const { navigation, currentDock } = useDockNavigation();
  const route = parseAutomationsRoute(currentDock?.pointer, currentDock?.options);
  const { data: automations = [] } = useAutomations();
  const yours = automations.filter((a) => a.group !== 'builtin');
  const failing = automations.filter((a) => a.last_run?.status === 'failed').length;

  const item = (place: AutomationsPlace, icon: ReactNode, label: ReactNode, badge?: ReactNode) => (
    <button
      type="button"
      data-testid={`automations-nav-${place}`}
      aria-current={route.place === place ? 'page' : undefined}
      onClick={() => navigation.openDock(DockPointer.forAutomations({ place }))}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60',
        route.place === place && 'bg-accent font-medium',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </button>
  );

  return (
    <nav className="flex flex-col gap-0.5 p-2" data-testid="automations-navigator">
      {item(
        'list',
        <ListChecks className="size-4 shrink-0" aria-hidden />,
        <Trans>My automations</Trans>,
        <span className="text-xs tabular-nums text-muted-foreground">{yours.length}</span>,
      )}
      {item(
        'runs',
        <History className="size-4 shrink-0" aria-hidden />,
        <Trans>Runs</Trans>,
        failing > 0 ? (
          <span
            className="rounded-full border border-red-500/60 bg-red-500/10 px-1.5 text-[11px] tabular-nums"
            data-testid="automations-nav-failing"
          >
            {failing}
          </span>
        ) : null,
      )}
      {item(
        'bus',
        <Radio className="size-4 shrink-0" aria-hidden />,
        <Trans>Event bus</Trans>,
        <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">
          <Trans>Advanced</Trans>
        </span>,
      )}
    </nav>
  );
}
