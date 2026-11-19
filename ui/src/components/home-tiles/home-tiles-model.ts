import type { Agent, Deployment, Issue } from '@sdk';
import { deploymentsByAgent, deploymentsByProject, isUserAgent } from '@src/components/asset-counters/agent-counters';
import { issuesConcerning } from '@src/components/asset-counters/issue-counters';
import { roleOf } from '@src/components/items/role';
import type { ProjectApp } from '@src/components/top-nav-bar/use-project-apps';

/** How many deployments the panel lists before paging. */
export const DEPLOYMENTS_PAGE_SIZE = 10;

/**
 * One icon on the home: an agent or an app. It stands for the thing itself when it is yours (`own`),
 * and for the deployments of it you can run. A deployment never gets an icon of its own.
 */
export interface HomeTile {
  /** The typeid of the agent / app the icon stands for; the selection in the URL. */
  key: string;
  kind: 'agent' | 'app';
  label: string;
  /** Absent for deployments of an agent you cannot read. */
  agent?: Agent;
  app?: ProjectApp;
  own: boolean;
  deployments: Deployment[];
  /** Open issues on the thing itself or on any of its deployments. */
  issueCount: number;
}

/** What the side panel shows for the URL's `tile` / `tileDeployment`. */
export interface HomeSelection {
  tile: HomeTile;
  /** The selected deployment; null when the selection is the agent / app itself, or nothing yet. */
  deployment: Deployment | null;
  /** The deployments listed to pick from. */
  listed: Deployment[];
  /** The deployment was opened from a list: the panel is a breadcrumbed sub view of it. */
  subView: boolean;
}

function issueCount(issues: Issue[], typeids: string[]): number {
  return new Set(typeids.flatMap((typeid) => issuesConcerning(issues, typeid).map((issue) => issue.id))).size;
}

function tileOf(
  base: Pick<HomeTile, 'key' | 'kind' | 'label' | 'agent' | 'app' | 'own'>,
  deployments: Deployment[],
  issues: Issue[],
): HomeTile {
  const typeids = [base.key, ...deployments.map((d) => d.typeId.toString())];
  return { ...base, deployments, issueCount: issueCount(issues, typeids) };
}

/**
 * The agent icons: the project's agents, then every other agent that has deployments you can reach.
 * `knownAgents` names those others when you can read them; one you own counts as yours.
 */
export function buildAgentTiles(
  projectAgents: Agent[],
  knownAgents: Agent[],
  deployments: Deployment[],
  issues: Issue[],
): HomeTile[] {
  const byAgent = deploymentsByAgent(deployments);
  const tiles = projectAgents.map((agent) => {
    const key = agent.typeId.toString();
    return tileOf({ key, kind: 'agent', label: agent.displayName, agent, own: true }, byAgent.get(key) ?? [], issues);
  });
  const shown = new Set(tiles.map((tile) => tile.key));
  const known = new Map(knownAgents.filter(isUserAgent).map((agent) => [agent.typeId.toString(), agent]));
  for (const [key, list] of byAgent) {
    if (shown.has(key)) continue;
    const agent = known.get(key);
    const label = agent?.displayName ?? list[0].name;
    tiles.push(tileOf({ key, kind: 'agent', label, agent, own: roleOf(agent) === 'owner' }, list, issues));
  }
  return tiles;
}

/**
 * The app icons. An app runs wherever its project is deployed, so its deployments are its project's —
 * except the project's own placement on this machine, which is the app itself.
 */
export function buildAppTiles(apps: ProjectApp[], deployments: Deployment[], issues: Issue[]): HomeTile[] {
  const byProject = deploymentsByProject(deployments);
  return apps.map((entry) => {
    const { app } = entry;
    const key = app.typeId.toString();
    const placed = ((app.project_id && byProject.get(app.project_id)) || []).filter((d) => !d.isLocal);
    return tileOf({ key, kind: 'app', label: app.displayName ?? app.name, app: entry, own: true }, placed, issues);
  });
}

/**
 * Yours: the selection is the thing itself, with its deployments listed. Not yours with one deployment:
 * that deployment. Not yours with several: the list only, until one is picked.
 */
export function resolveSelection(
  tiles: HomeTile[],
  tileKey: string | null | undefined,
  deploymentId: string | null | undefined,
): HomeSelection | null {
  const tile = tiles.find((candidate) => candidate.key === tileKey);
  if (!tile) return null;
  if (!tile.own && tile.deployments.length === 1) {
    return { tile, deployment: tile.deployments[0], listed: [], subView: false };
  }
  const deployment = tile.deployments.find((d) => d.id === deploymentId) ?? null;
  return { tile, deployment, listed: deployment ? [] : tile.deployments, subView: !!deployment };
}

/** The count on the icon: how many deployments a click lists. A lone deployment that IS the selection has none. */
export function deploymentCount(tile: HomeTile): number {
  return tile.own || tile.deployments.length > 1 ? tile.deployments.length : 0;
}

/** Whether the icon reads as "this machine": the thing itself is here, or every deployment of it is. */
export function tileIsLocal(tile: HomeTile): boolean {
  return tile.own || tile.deployments.every((d) => d.isLocal);
}

export function pageOf<T>(items: T[], page: number): { rows: T[]; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / DEPLOYMENTS_PAGE_SIZE));
  const at = Math.min(Math.max(page, 0), pages - 1) * DEPLOYMENTS_PAGE_SIZE;
  return { rows: items.slice(at, at + DEPLOYMENTS_PAGE_SIZE), pages };
}
