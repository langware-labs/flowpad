import { useLingui } from '@lingui/react/macro';
import { Check, LayoutGrid, Pencil } from 'lucide-react';
import { useState } from 'react';
import { WebApp, type Project } from '@sdk';
import { useProjectAgents } from '@src/hooks/use-project-agents';
import { useAgentLauncher } from '@src/components/agents/use-agent-launcher';
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
import { DockPointer } from '@src/navigation/DockPointer';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { NavIconButton } from './NavIconButton';
import { projectAppDock, useProjectApps, type ProjectApp } from './use-project-apps';

/**
 * The project's apps and agents, with registry icons for each type. A lone app
 * opens directly; otherwise the button offers the full list.
 *
 * An app opens as its OWN top-level tab (never a child of the Vibe workspace on screen); the load
 * that starts an app that is not running belongs to the view it lands on. An agent opens in Vibe:
 * its last chat in this project, else a new one (`agentSessionDock`). Which app is showing is read
 * off the URL. Absent when the project has no apps or agents, and on the hub, which starts nothing.
 */
export function AppButton({ project }: { project?: Project | null }) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const apps = useProjectApps(project);
  const { agents } = useProjectAgents(project);
  const { launch } = useAgentLauncher();
  const [menuOpen, setMenuOpen] = useState(false);
  if (isHubOnly() || !project || (!apps.length && !agents.length)) return null;

  const projectId = String(project.id);
  const shownId = appDockAddress(currentDock ?? null)?.microAppId ?? null;
  const open = (entry: ProjectApp) =>
    navigation.openDock(projectAppDock(entry, projectId), undefined, { topLevel: true });

  const label = t`Apps and agents`;
  // The app's editor (`webapp.json` as a form) — the same URL the asset list opens.
  const edit = (entry: ProjectApp) =>
    navigation.openDock(DockPointer.forAssetEditorByTypeId(WebApp.type, entry.app.typeId));

  if (apps.length === 1 && !agents.length) {
    const [only] = apps;
    const showing = only.app.id === shownId;
    return (
      <>
      <NavIconButton
        icon={iconForType(only.app.type)}
        label={label}
        onClick={() => open(only)}
        disabled={showing}
        tooltipDelay={1500}
        testId="top-nav-app"
      />
      <NavIconButton
        icon={Pencil}
        label={t`Edit ${only.app.displayName}`}
        onClick={() => edit(only)}
        tooltipDelay={1500}
        testId={`top-nav-app-edit-${only.app.name}`}
      />
      </>
    );
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip delayDuration={1500}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={chromeEntityActionClassName}
              aria-label={label}
              data-testid="top-nav-apps"
            >
              <LayoutGrid />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {label}
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
              className="group gap-2"
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{entry.app.displayName}</span>
              {entry.providerProjectId !== projectId && <Badge variant="outline">{t`Package`}</Badge>}
              <Badge variant="secondary">{entry.app.audience === 'admin' ? t`Admin` : t`User`}</Badge>
              <Check
                className={entry.app.id === shownId ? 'size-3.5' : 'invisible size-3.5'}
                aria-hidden={entry.app.id !== shownId}
              />
              <button
                type="button"
                aria-label={t`Edit ${entry.app.displayName}`}
                title={t`Edit app`}
                data-testid={`top-nav-app-edit-${entry.app.name}`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-data-[highlighted]:opacity-100"
                // The row opens the running app; the pencil opens its editor instead.
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  edit(entry);
                }}
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
            </DropdownMenuItem>
          );
        })}
        {agents.map((agent) => {
          const Icon = iconForType(agent.type);
          return (
            <DropdownMenuItem
              key={agent.typeId.toString()}
              data-testid={`top-nav-agent-${agent.name}`}
              onSelect={() => void launch(agent, projectId)}
              className="group gap-2"
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{agent.displayName}</span>
              <button
                type="button"
                aria-label={t`Edit ${agent.displayName}`}
                title={t`Edit agent`}
                data-testid={`top-nav-agent-edit-${agent.name}`}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-data-[highlighted]:opacity-100"
                // The row launches the agent; the pencil opens its editor instead.
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  navigation.openDock(DockPointer.forAssetEditorByTypeId(agent.typeId.type, agent.typeId));
                }}
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
