/**
 * The home's icons: one per agent / app, standing for the thing itself when it is yours and for the
 * deployments of it you can run. What a click selects follows from that alone.
 */
import type { Agent, Deployment, Issue } from '@sdk';
import {
  buildAgentTiles,
  buildAppTiles,
  buildHubAgentTiles,
  deploymentCount,
  pageOf,
  resolveSelection,
  standsForItself,
  tileIsLocal,
  TILES_PAGE_SIZE,
} from '@src/components/home-tiles/home-tiles-model';
import type { ProjectApp } from '@src/components/top-nav-bar/use-project-apps';
import { describe, expect, it } from 'vitest';

const typeId = (value: string) => ({ toString: () => value });
const agent = (id: string, roles?: string[]) =>
  ({ id, name: id, displayName: id.toUpperCase(), typeId: typeId(`agent-${id}`), expand: { roles } }) as unknown as Agent;
const deployment = (id: string, agentId: string | null, opts: { local?: boolean; project?: string } = {}) =>
  ({
    id,
    name: `dep ${id}`,
    isLocal: !!opts.local,
    typeId: typeId(`deployment-${id}`),
    mainAgentTypeId: agentId ? typeId(`agent-${agentId}`) : null,
    projectTypeId: opts.project ? { id: opts.project } : null,
  }) as unknown as Deployment;
const issue = (id: string, subject: string, status = 'open') =>
  ({ id, subject_typeid: subject, affected: [], severity: 'error', status }) as unknown as Issue;

describe('agent icons', () => {
  const mine = agent('mine');
  const withDeps = agent('busy');
  const ownedElsewhere = agent('elsewhere', ['OWNER']);
  const readable = agent('shared', ['READER']);
  const deployments = [
    deployment('b1', 'busy'),
    deployment('b2', 'busy', { local: true }),
    deployment('e1', 'elsewhere'),
    deployment('s1', 'shared'),
    deployment('s2', 'shared'),
    deployment('u1', 'unreadable', { local: true }),
    deployment('orphan', null),
  ];
  const issues = [issue('i1', 'agent-busy'), issue('i2', 'deployment-b1'), issue('i3', 'deployment-s2'), issue('i4', 'agent-mine', 'resolved')];
  const tiles = buildAgentTiles([mine, withDeps], [mine, withDeps, ownedElsewhere, readable], deployments, issues);
  const byKey = Object.fromEntries(tiles.map((tile) => [tile.key, tile]));

  it('shows the project agents, then one icon per other agent that has deployments', () => {
    expect(tiles.map((tile) => tile.key)).toEqual(['agent-mine', 'agent-busy', 'agent-elsewhere', 'agent-shared', 'agent-unreadable']);
    expect(byKey['agent-unreadable'].label).toBe('dep u1');
    expect(tiles.map((tile) => tile.own)).toEqual([true, true, true, false, false]);
  });

  it('in project scope shows only the project agents, each with its deployments', () => {
    const scoped = buildAgentTiles([mine, withDeps], [mine, withDeps, ownedElsewhere, readable], deployments, issues, 'project');
    expect(scoped.map((tile) => tile.key)).toEqual(['agent-mine', 'agent-busy']);
    expect(scoped.map(deploymentCount)).toEqual([0, 2]);
  });

  it('counts the deployments a click lists, and the open issues on the agent or any of them', () => {
    expect(tiles.map(deploymentCount)).toEqual([0, 2, 1, 2, 0]);
    expect(tiles.map((tile) => tile.issueCount)).toEqual([0, 2, 0, 1, 0]);
    expect([...byKey['agent-busy'].deploymentIssues]).toEqual([['b1', 1]]);
    expect(tiles.map((tile) => tileIsLocal(tile))).toEqual([true, true, true, false, true]);
  });

  it('selects the agent when it is yours, and lists its deployments', () => {
    const selection = resolveSelection(tiles, 'agent-busy', null);
    expect(selection).toMatchObject({ deployment: null, subView: false });
    expect(selection?.listed.map((d) => d.id)).toEqual(['b1', 'b2']);
  });

  it('opens a listed deployment as a sub view', () => {
    const selection = resolveSelection(tiles, 'agent-busy', 'b2');
    expect(selection?.deployment?.id).toBe('b2');
    expect(selection).toMatchObject({ listed: [], subView: true });
  });

  it('selects nothing for deployments of an agent that is not yours until one is picked', () => {
    expect(resolveSelection(tiles, 'agent-shared', null)).toMatchObject({ deployment: null, subView: false });
    expect(resolveSelection(tiles, 'agent-shared', 's2')).toMatchObject({ deployment: { id: 's2' }, subView: true });
  });

  it('selects the one deployment directly, with no list', () => {
    expect(resolveSelection(tiles, 'agent-unreadable', null)).toMatchObject({ deployment: { id: 'u1' }, listed: [], subView: false });
  });

  it('ignores a selection that names nothing shown', () => {
    expect(resolveSelection(tiles, 'agent-gone', null)).toBeNull();
    expect(resolveSelection(tiles, 'agent-busy', 'gone')).toMatchObject({ deployment: null, subView: false });
  });
});

describe('hub agent icons', () => {
  const mine = agent('mine', ['OWNER']);
  const busy = agent('busy', ['OWNER']);
  const sharedIdle = agent('idle', ['READER']);
  const sharedBusy = agent('shared', ['READER']);
  const system = { ...agent('assistant', ['OWNER']), scope: 'system' } as unknown as Agent;
  const local = deployment('l1', 'busy', { local: true });
  const deployments = [deployment('b1', 'busy'), deployment('s1', 'shared'), local];
  const tiles = buildHubAgentTiles([sharedIdle, system, busy, sharedBusy, mine], deployments, []);

  it('shows every agent you can reach: yours by name, then those with deployments, then the rest shared', () => {
    expect(tiles.map((tile) => tile.key)).toEqual(['agent-busy', 'agent-mine', 'agent-shared', 'agent-idle']);
    expect(tiles.map((tile) => tile.own)).toEqual([true, true, false, false]);
  });

  it('lets a shared agent with nothing deployed stand for itself', () => {
    expect(tiles.map(standsForItself)).toEqual([true, true, false, true]);
    expect(resolveSelection(tiles, 'agent-idle', null)).toMatchObject({ deployment: null, listed: [], subView: false });
  });

  it('puts what is yours in the cloud, not on this machine', () => {
    expect(tiles.map((tile) => tileIsLocal(tile, false))).toEqual([false, false, false, false]);
    expect(tileIsLocal({ ...tiles[0], deployments: [local] }, false)).toBe(true);
  });
});

describe('app icons', () => {
  it('lists the deployments of the app project, without its own placement on this machine', () => {
    const app = { id: 'a', name: 'board', displayName: 'Board', project_id: 'p', typeId: typeId('micro_app-a') };
    const tiles = buildAppTiles(
      [{ app, providerProjectId: 'p' } as unknown as ProjectApp],
      [deployment('here', null, { project: 'p', local: true }), deployment('cloud', null, { project: 'p' }), deployment('other', null, { project: 'q' })],
      [issue('i1', 'micro_app-a')],
    );
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ key: 'micro_app-a', kind: 'app', label: 'Board', own: true, issueCount: 1 });
    expect(tiles[0].deployments.map((d) => d.id)).toEqual(['cloud']);
  });

  it('puts no deployment count on an app: every app of the project would show the same one', () => {
    const app = (id: string) => ({ id, name: id, displayName: id, project_id: 'p', typeId: typeId(`micro_app-${id}`) });
    const tiles = buildAppTiles(
      [app('a'), app('b')].map((entry) => ({ app: entry, providerProjectId: 'p' }) as unknown as ProjectApp),
      [deployment('c1', null, { project: 'p' }), deployment('c2', null, { project: 'p' })],
      [],
    );
    expect(tiles.map((tile) => tile.deployments.length)).toEqual([2, 2]);
    expect(tiles.map(deploymentCount)).toEqual([0, 0]);
  });
});

describe('deployment pages', () => {
  it('shows ten at a time and clamps the page', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(pageOf(items, 0)).toEqual({ rows: items.slice(0, 10), first: 1, pages: 3, page: 0 });
    expect(pageOf(items, 2)).toMatchObject({ rows: [20, 21, 22, 23, 24], first: 21 });
    expect(pageOf(items, 9)).toMatchObject({ rows: [20, 21, 22, 23, 24], first: 21, page: 2 });
    expect(pageOf([], 0)).toEqual({ rows: [], first: 1, pages: 1, page: 0 });
  });

  it('pages icons 25 at a time', () => {
    const items = Array.from({ length: 48 }, (_, i) => i);
    expect(pageOf(items, 0, TILES_PAGE_SIZE)).toMatchObject({ first: 1, pages: 2, page: 0 });
    expect(pageOf(items, 1, TILES_PAGE_SIZE).rows).toEqual(items.slice(25));
  });
});
