import { dataContext, PageId, TypeId, ViewType, WorldViewProjection, type WorldViewGraph } from '@sdk';
import { worldViewGraphFromPayload } from '@src/components/graph-view/graph/loadWorldView';
import { cameraRatioForVisibleSpan } from '@src/components/graph-view/graph/graphCamera';
import { compactGraphLabel, fitLabelToWidth } from '@src/components/graph-view/graph/graphLabels';
import { DockPointer } from '@src/navigation/DockPointer';
import { canonicalWorldViewDockPath } from '@src/navigation/worldview-dock-canonicalization';
import { DockLoadError } from '@src/routes/loaders/dock-load-error';
import { loadGraphIdentityRoute } from '@src/routes/loaders/load-dock-pointer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT_ID = 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa';
const CHILD_ID = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb';

function payload(overrides: Partial<WorldViewGraph> = {}): WorldViewGraph {
  const base: WorldViewGraph = {
    schema_version: 1,
    projection: WorldViewProjection.DEPLOYMENT,
    root: `deployment-${ROOT_ID}`,
    nodes: [
      {
        type: 'deployment',
        id: ROOT_ID,
        key: `deployment-${ROOT_ID}`,
        label: 'Deployment WorldView',
        is_ghost: false,
        properties: {},
      },
      {
        type: 'deployment',
        id: CHILD_ID,
        key: `deployment-${CHILD_ID}`,
        label: 'web',
        is_ghost: false,
        properties: {},
      },
    ],
    edges: [
      {
        from: { type: 'deployment', id: ROOT_ID },
        to: { type: 'deployment', id: CHILD_ID },
        kind: 'child',
        topology: 'hierarchy',
      },
    ],
    counts: { nodes: 2, edges: 1 },
    sync: null,
  };
  return { ...base, ...overrides };
}

describe('WorldView route identity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses a projection pointer and exposes query focus as the tab target', () => {
    const root = new TypeId('deployment', ROOT_ID);
    const dock = DockPointer.forWorldView(WorldViewProjection.DEPLOYMENT, {
      focus: root,
      depth: 6,
      selected: `deployment-${CHILD_ID}`,
    });
    const parsed = DockPointer.fromUrl(dock.toUrl());

    expect(dock.toUrl()).toBe(
      `/dock/worldview/deployment?focus=deployment-${ROOT_ID}&depth=6&selected=deployment-${CHILD_ID}`,
    );
    expect(parsed.targetTypeId?.toString()).toBe(root.toString());
    expect(DockPointer.parseWorldViewProjection(parsed.pointer)).toBe('deployment');
  });

  it('loader writes only URL focus identity into context', async () => {
    const setActive = vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue(undefined as never);
    const dock = DockPointer.forWorldView(WorldViewProjection.DEPLOYMENT, {
      focus: `deployment-${ROOT_ID}`,
    });

    await loadGraphIdentityRoute(dock, 'worldview');

    expect(setActive).toHaveBeenCalledTimes(1);
    expect((setActive.mock.calls[0][0] as TypeId).toString()).toBe(`deployment-${ROOT_ID}`);
  });

  it('rejects a non-projection pointer before the view mounts', async () => {
    const dock = new DockPointer(ViewType.WORLDVIEW, `project/${ROOT_ID}`);

    await expect(loadGraphIdentityRoute(dock, 'worldview')).rejects.toBeInstanceOf(DockLoadError);
  });

  it('canonicalizes retired Atlas and entity-root URLs in the route loader', () => {
    expect(canonicalWorldViewDockPath('/dock/hub/atlas/organization', '')).toBe('/dock/hub/worldview/organization');
    expect(canonicalWorldViewDockPath('/dock/hub/worldview/world', '?signal=cost&hide=user,artifact')).toBe(
      '/dock/hub/worldview/world?hide=artifact%2Cuser',
    );
    expect(canonicalWorldViewDockPath(`/dock/worldview/deployment/${ROOT_ID}`, '?color=cost')).toBe(
      `/dock/worldview/deployment?signal=cost&focus=deployment-${ROOT_ID}`,
    );
    const persisted = DockPointer.fromJSON(JSON.stringify({ viewType: 'atlas', pointer: 'world' }));
    expect(persisted?.page).toBe(PageId.HUB);
    expect(persisted?.toUrl()).toBe('/dock/hub/worldview/world');
  });
});

describe('WorldView graph projection', () => {
  it('keeps hierarchy topology, root, and directed edges for the circle renderer', () => {
    const graph = worldViewGraphFromPayload(payload());

    expect(graph.type).toBe('directed');
    expect(graph.multi).toBe(true);
    expect(graph.getAttribute('worldViewRoot')).toBe(`deployment-${ROOT_ID}`);
    expect(graph.hasDirectedEdge(`deployment-${ROOT_ID}`, `deployment-${CHILD_ID}`)).toBe(true);
    expect(graph.getEdgeAttribute(graph.edges()[0], 'topology')).toBe('hierarchy');
  });

  it('preserves projection-safe backend properties without a second UI schema', () => {
    const graph = worldViewGraphFromPayload(
      payload({
        nodes: [
          {
            type: 'deployment',
            id: ROOT_ID,
            key: `deployment-${ROOT_ID}`,
            label: 'root',
            is_ghost: false,
            properties: { kind: 'gcp.project', provider_labels: { environment: 'demo' }, role: 'owner' },
          },
        ],
        edges: [],
        counts: { nodes: 1, edges: 0 },
      }),
    );

    expect(graph.getNodeAttribute(`deployment-${ROOT_ID}`, 'properties')).toEqual({
      kind: 'gcp.project',
      provider_labels: { environment: 'demo' },
      role: 'owner',
    });
  });

  it('keeps distinct role edges between the same entities', () => {
    const graph = worldViewGraphFromPayload(
      payload({
        edges: [
          {
            from: { type: 'deployment', id: ROOT_ID },
            to: { type: 'deployment', id: CHILD_ID },
            kind: 'owner',
            topology: 'association',
          },
          {
            from: { type: 'deployment', id: ROOT_ID },
            to: { type: 'deployment', id: CHILD_ID },
            kind: 'editor',
            topology: 'association',
          },
        ],
        counts: { nodes: 2, edges: 2 },
      }),
    );

    expect(graph.size).toBe(2);
  });

  it('uses compact canvas labels while preserving the complete source label', () => {
    const fullLabel = `projects/demo/secrets/default_compute_node-${CHILD_ID}/versions/1`;
    const graph = worldViewGraphFromPayload(
      payload({
        root: `deployment-${CHILD_ID}`,
        nodes: [
          {
            type: 'deployment',
            id: CHILD_ID,
            key: `deployment-${CHILD_ID}`,
            label: fullLabel,
            is_ghost: false,
            properties: {},
          },
        ],
        edges: [],
        counts: { nodes: 1, edges: 0 },
      }),
    );
    const key = `deployment-${CHILD_ID}`;

    expect(graph.getNodeAttribute(key, 'label')).toBe(fullLabel);
    expect(graph.getNodeAttribute(key, 'displayLabel')).toBe('default_compute_node-bbbbbbbb… · 1');
    expect(compactGraphLabel('short service')).toBe('short service');
  });

  it('fits canvas text by measured width without losing both ends', () => {
    const label = fitLabelToWidth('alpha-very-long-resource-omega', (value) => Array.from(value).length, 14);

    expect(Array.from(label).length).toBeLessThanOrEqual(14);
    expect(label.startsWith('alpha')).toBe(true);
    expect(label.endsWith('ega')).toBe(true);
  });

  it('allows focused dense regions to zoom beyond the old camera floor', () => {
    expect(cameraRatioForVisibleSpan(0.001, 4)).toBeCloseTo(0.0014);
    expect(cameraRatioForVisibleSpan(0, 1)).toBe(0.08);
  });
});
