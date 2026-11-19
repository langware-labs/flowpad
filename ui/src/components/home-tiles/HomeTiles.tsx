import { Agent, Deployment, WebApp, type Project } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { Cloud, Monitor } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { AgentAvatar } from '@src/components/agents/AgentAvatar';
import { useAgentLauncher } from '@src/components/agents/use-agent-launcher';
import { ALL_AGENTS, ALL_DEPLOYMENTS } from '@src/components/asset-counters/agent-counters';
import { useIssues } from '@src/components/asset-counters/issue-counters';
import { colorForIdentityKey } from '@src/components/conversation/avatar-color';
import { initialsFromLabel } from '@src/components/conversation/participant-display';
import { labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { DesktopTile, TileSection } from '@src/components/quick-create/QuickCreatePanel';
import { useOpenProjectApp, useProjectApps } from '@src/components/top-nav-bar/use-project-apps';
import { WebAppAvatar } from '@src/components/webapp-display/WebAppIcon';
import { MAX_HOME_AGENTS, useProjectAgents } from '@src/hooks/use-project-agents';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  buildAgentTiles,
  buildAppTiles,
  deploymentCount,
  loneDeployment,
  resolveSelection,
  tileIsLocal,
  type HomeSelection,
  type HomeTile,
} from './home-tiles-model';

/*
 * Desktop home only for now (approved 2026-11-19): the hub home still lists its items with `ItemsSection`,
 * whose Machines / Deployments / Channels drill-ins have no place here yet. Nothing below is desk-only,
 * so the hub home can mount the same two components.
 */

const NO_AGENTS: Agent[] = [];
const NO_DEPLOYMENTS: Deployment[] = [];

export interface HomeTilesState {
  agents: HomeTile[];
  apps: HomeTile[];
  selection: HomeSelection | null;
  /** Select an icon, or a deployment inside it. The URL is the only place the selection lives. */
  select: (tileKey: string | null, deploymentId?: string | null) => void;
  /** What a double click on the icon, or Open in the panel, does. */
  open: (tile: HomeTile, deployment?: Deployment | null) => void;
  /** The agent's / app's own page. */
  manage: (tile: HomeTile) => void;
  /** The key of the icon whose agent session is starting. */
  busyKey: string | null;
}

/** The home's icons and what is selected, read from the data the counters already watch and from the URL. */
export function useHomeTiles(project: Project | null | undefined): HomeTilesState {
  const { navigation, currentDock } = useDockNavigation();
  const { agents: projectAgents } = useProjectAgents(project);
  const { data: knownAgents = NO_AGENTS } = useEntitiesQuery<Agent>(ALL_AGENTS);
  const { data: deployments = NO_DEPLOYMENTS } = useEntitiesQuery<Deployment>(ALL_DEPLOYMENTS);
  const { issues } = useIssues();
  const projectApps = useProjectApps(project);
  const projectId = project?.id ? String(project.id) : '';
  const openApp = useOpenProjectApp(projectId);
  const { launch, busyId } = useAgentLauncher();

  const agents = useMemo(
    () => buildAgentTiles(projectAgents.slice(0, MAX_HOME_AGENTS), knownAgents, deployments, issues),
    [projectAgents, knownAgents, deployments, issues],
  );
  const apps = useMemo(() => buildAppTiles(projectApps, deployments, issues), [projectApps, deployments, issues]);

  const { key: tileKey, deployment: deploymentId } = currentDock?.homeTile ?? {};
  const selection = useMemo(
    () => resolveSelection(agents, tileKey, deploymentId) ?? resolveSelection(apps, tileKey, deploymentId),
    [agents, apps, tileKey, deploymentId],
  );

  const select = useCallback(
    (key: string | null, deployment: string | null = null) => {
      if (currentDock) navigation.openDock(currentDock.withHomeTile(key, deployment));
    },
    [navigation, currentDock],
  );

  const open = useCallback(
    (tile: HomeTile, deployment: Deployment | null = null) => {
      // A deployment opens where a deployment row opens everywhere else: its page.
      const placed = deployment ?? loneDeployment(tile);
      if (placed) navigation.openDock(placed.projectPagePointer ?? placed.dockPointer);
      else if (!tile.own) return;
      else if (tile.app) void openApp(tile.app);
      else if (tile.agent?.enabled) void launch(tile.agent, projectId || null, { fresh: true });
    },
    [navigation, openApp, launch, projectId],
  );

  const manage = useCallback(
    (tile: HomeTile) => {
      if (tile.agent) navigation.openDock(tile.agent.dockPointer);
      else if (tile.app) navigation.openDock(DockPointer.forAssetEditorByTypeId(WebApp.type, tile.app.app.typeId));
    },
    [navigation],
  );

  const busyKey = busyId ? (agents.find((tile) => tile.agent?.id === busyId)?.key ?? null) : null;
  return { agents, apps, selection, select, open, manage, busyKey };
}

/** The face of an icon: the agent's or app's own, else the initial of its name. */
export function TileFace({ tile, className, glyphClassName }: { tile: HomeTile; className: string; glyphClassName: string }) {
  if (tile.agent) return <AgentAvatar agent={tile.agent} className={className} glyphClassName={glyphClassName} />;
  if (tile.app) return <WebAppAvatar app={tile.app.app} className={className} glyphClassName={glyphClassName} />;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        colorForIdentityKey(tile.key),
        className,
      )}
    >
      {initialsFromLabel(tile.label, 1)}
    </span>
  );
}

/** The number on an icon: how many deployments (`primary`), or how many open issues (`issues`). */
export function TileCount({ value, tone, testId }: { value: number; tone: 'primary' | 'issues'; testId?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums',
        tone === 'issues' ? 'bg-red-500 text-white' : 'bg-primary text-primary-foreground',
      )}
      data-testid={testId}
    >
      {value}
    </span>
  );
}

/** Where something runs: this machine, or the cloud. */
export function WhereIcon({ local, className }: { local: boolean; className?: string }) {
  const Icon = local ? Monitor : Cloud;
  return <Icon className={className} aria-hidden />;
}

function Tile({ tile, home }: { tile: HomeTile; home: HomeTilesState }) {
  const { t } = useLingui();
  const selected = home.selection?.tile.key === tile.key;
  const count = deploymentCount(tile);
  const local = tileIsLocal(tile);
  const where = local ? t`Runs on this machine` : t`Runs in the cloud`;
  return (
    <div className="relative h-20 w-20">
      <DesktopTile
        iconSlot={<TileFace tile={tile} className="h-9 w-9 text-sm" glyphClassName="h-5 w-5 text-xl" />}
        label={tile.label}
        loading={home.busyKey === tile.key}
        aria-pressed={selected}
        className={selected ? 'border-primary bg-accent text-foreground ring-2 ring-primary' : undefined}
        onClick={() => home.select(tile.key)}
        onDoubleClick={() => home.open(tile)}
        data-testid={tile.kind === 'agent' ? 'project-agent-tile' : 'project-app-tile'}
        data-agent-name={tile.agent?.name}
        data-tile-key={tile.key}
      />
      {tile.kind === 'agent' && (
        <span
          className="pointer-events-none absolute left-12 top-8 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm"
          title={where}
          aria-label={where}
          data-testid="home-tile-where"
          data-where={local ? 'local' : 'cloud'}
        >
          <WhereIcon local={local} className="h-3 w-3" />
        </span>
      )}
      {count > 0 && (
        <span className="pointer-events-none absolute -right-1.5 -top-1.5 z-10" title={t`${count} deployments`}>
          <TileCount value={count} tone="primary" testId="home-tile-deployments" />
        </span>
      )}
      {tile.issueCount > 0 && (
        <span className="pointer-events-none absolute left-1 top-1 z-10" title={t`${tile.issueCount} open issues`}>
          <TileCount value={tile.issueCount} tone="issues" testId="home-tile-issues" />
        </span>
      )}
    </div>
  );
}

/** The home's agents and apps: one icon each. A click selects, a double click opens. */
export function HomeTiles({ home, className }: { home: HomeTilesState; className?: string }) {
  if (!home.agents.length && !home.apps.length) return null;
  return (
    <div className={cn('flex flex-col gap-4 text-start', className)} data-testid="home-tiles">
      {home.agents.length > 0 && (
        <div data-testid="project-agents-strip">
          <TileSection title={labelForType(Agent.type)}>
            {home.agents.map((tile) => (
              <Tile key={tile.key} tile={tile} home={home} />
            ))}
          </TileSection>
        </div>
      )}
      {home.apps.length > 0 && (
        <div data-testid="project-home-apps">
          <TileSection title={<Trans>Apps</Trans>}>
            {home.apps.map((tile) => (
              <Tile key={tile.key} tile={tile} home={home} />
            ))}
          </TileSection>
        </div>
      )}
    </div>
  );
}
