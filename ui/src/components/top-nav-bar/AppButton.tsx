import { useLingui } from '@lingui/react/macro';
import { Check, LayoutGrid } from 'lucide-react';
import type { Project } from '@sdk';
import { useProjectAgents } from '@src/hooks/use-project-agents';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { chromeEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { appDockAddress } from '@src/navigation/app-dock';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { NavIconButton } from './NavIconButton';
import { projectAppDock, useProjectApps, type ProjectApp } from './use-project-apps';

/**
 * The project's apps and agents, with registry icons for each type. A lone app
 * opens directly; otherwise the button offers the full list.
 *
 * The click only navigates: the app opens in place, where the user already is (no tab of its own),
 * and the load that starts an app that is not running belongs to the view it lands on. Which app is showing is
 * read off the URL. Absent when the project has no apps or agents, and on the hub, which starts nothing.
 */
export function AppButton({ project }: { project?: Project | null }) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const apps = useProjectApps(project);
  const { agents } = useProjectAgents(project);
  if (isHubOnly() || !project || (!apps.length && !agents.length)) return null;

  const projectId = String(project.id);
  const shownId = appDockAddress(currentDock ?? null)?.microAppId ?? null;
  const open = (entry: ProjectApp) => navigation.openDock(projectAppDock(entry, projectId));

  const tooltipContent = (
    <div className="space-y-1">
      <div className="font-medium">{t`Apps and agents`}</div>
      {[
        ...apps.map(({ app }) => ({ id: app.id, type: app.type, name: app.name })),
        ...agents.map((agent) => ({ id: agent.id, type: agent.type, name: agent.displayName })),
      ].map((entry) => {
        const Icon = iconForType(entry.type);
        return (
          <div key={`${entry.type}-${entry.id}`} className="flex items-center gap-2">
            <Icon className="size-4 shrink-0" aria-hidden />
            <span>{entry.name}</span>
          </div>
        );
      })}
    </div>
  );

  if (apps.length === 1 && !agents.length) {
    const [only] = apps;
    const showing = only.app.id === shownId;
    return (
      <NavIconButton
        icon={iconForType(only.app.type)}
        label={t`Apps and agents`}
        onClick={() => open(only)}
        disabled={showing}
        tooltipContent={tooltipContent}
        tooltipDelay={1500}
        testId="top-nav-app"
      />
    );
  }

  return (
    <DropdownMenu>
      <Tooltip delayDuration={1500}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={chromeEntityActionClassName}
              aria-label={t`Apps and agents`}
              data-testid="top-nav-apps"
            >
              <LayoutGrid />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {tooltipContent}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-56">
        {apps.map((entry) => {
          const Icon = iconForType(entry.app.type);
          return (
            <DropdownMenuItem
              key={entry.app.id}
              data-testid={`top-nav-app-${entry.app.name}`}
              onSelect={() => open(entry)}
              className="gap-2"
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{entry.app.name}</span>
              {entry.providerProjectId !== projectId && <Badge variant="outline">{t`Package`}</Badge>}
              <Badge variant="secondary">{entry.app.audience === 'admin' ? t`Admin` : t`User`}</Badge>
              <Check
                className={entry.app.id === shownId ? 'size-3.5' : 'invisible size-3.5'}
                aria-hidden={entry.app.id !== shownId}
              />
            </DropdownMenuItem>
          );
        })}
        {agents.map((agent) => {
          const Icon = iconForType(agent.type);
          return (
            <DropdownMenuItem
              key={agent.typeId.toString()}
              data-testid={`top-nav-agent-${agent.name}`}
              onSelect={() => navigation.openDock(agent.dockPointer)}
              className="gap-2"
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{agent.displayName}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
