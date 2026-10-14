import { useLingui } from '@lingui/react/macro';
import { Check, LayoutGrid } from 'lucide-react';
import type { Project } from '@sdk';
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
 * The project's apps, one click away: a button that opens the app when there is one, and a list
 * of them — each with its type, user or admin — when there are more.
 *
 * The click only navigates: the app opens as a tab of its own (never beside a chat), and the load
 * that starts an app that is not running belongs to the view it lands on. Which app is showing is
 * read off the URL. Absent when the project has no app, and on the hub, which starts nothing.
 */
export function AppButton({ project }: { project?: Project | null }) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const apps = useProjectApps(project);
  if (isHubOnly() || !project || !apps.length) return null;

  const projectId = String(project.id);
  const shownId = appDockAddress(currentDock ?? null)?.microAppId ?? null;
  const open = (entry: ProjectApp) =>
    navigation.openDock(projectAppDock(entry, projectId), undefined, { topLevel: true });

  if (apps.length === 1) {
    const [only] = apps;
    const name = only.app.name;
    const showing = only.app.id === shownId;
    return (
      <NavIconButton
        icon={LayoutGrid}
        label={showing ? t`Showing ${name}` : t`Open ${name}`}
        onClick={() => open(only)}
        disabled={showing}
        testId="top-nav-app"
      />
    );
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={chromeEntityActionClassName}
              aria-label={t`Apps`}
              data-testid="top-nav-apps"
            >
              <LayoutGrid />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {t`Apps`}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-56">
        {apps.map((entry) => (
          <DropdownMenuItem
            key={entry.app.id}
            data-testid={`top-nav-app-${entry.app.name}`}
            onSelect={() => open(entry)}
            className="gap-2"
          >
            <span className="min-w-0 flex-1 truncate">{entry.app.name}</span>
            {entry.providerProjectId !== projectId && <Badge variant="outline">{t`Dependency`}</Badge>}
            <Badge variant="secondary">{entry.app.audience === 'admin' ? t`Admin` : t`User`}</Badge>
            <Check
              className={entry.app.id === shownId ? 'size-3.5' : 'invisible size-3.5'}
              aria-hidden={entry.app.id !== shownId}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
