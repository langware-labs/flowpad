import { dataContext, TypeId, ViewType } from '@sdk';
import { worldViewGraphFromPayload, safeWorldViewProperties } from '@src/components/graph-view/graph/loadWorldView';
import { cameraRatioForVisibleSpan } from '@src/components/graph-view/graph/graphCamera';
import { compactGraphLabel, fitLabelToWidth } from '@src/components/graph-view/graph/graphLabels';
import { DockPointer } from '@src/navigation/DockPointer';
import { DockLoadError } from '@src/routes/loaders/dock-load-error';
import { loadGraphIdentityRoute } from '@src/routes/loaders/load-dock-pointer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT_ID = 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa';
const CHILD_ID = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb';

describe('WorldView route identity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('round-trips a typed root and exposes it as the tab target', () => {
    const root = new TypeId('deployment', ROOT_ID);
    const dock = DockPointer.forWorldView(root, { depth: 4, selected: `deployment-${CHILD_ID}` });
    const url = dock.toUrl();
    const parsed = DockPointer.fromUrl(url);

    expect(url).toBe(`/dock/worldview/deployment/${ROOT_ID}?depth=4&selected=deployment-${CHILD_ID}`);
    expect(parsed.targetTypeId?.toString()).toBe(root.toString());
    expect(DockPointer.parseWorldViewPointer(parsed.pointer)).toEqual({ type: 'deployment', id: ROOT_ID });
  });

  it('loader writes only the URL root identity into context', async () => {
    const setActive = vi.spyOn(dataContext, 'setActiveEntityTypeId').mockResolvedValue(undefined as never);
    const dock = DockPointer.forWorldView(new TypeId('deployment', ROOT_ID));

    await loadGraphIdentityRoute(dock, 'worldview');

    expect(setActive).toHaveBeenCalledTimes(1);
    expect((setActive.mock.calls[0][0] as TypeId).toString()).toBe(`deployment-${ROOT_ID}`);
  });

  it('rejects non-Artifact/Deployment roots before the view mounts', async () => {
    const dock = new DockPointer(ViewType.WORLDVIEW, `project/${ROOT_ID}`);

    await expect(loadGraphIdentityRoute(dock, 'worldview')).rejects.toBeInstanceOf(DockLoadError);
  });
});

describe('WorldView graph projection', () => {
  it('keeps child edges directed for the circular layout', () => {
    const graph = worldViewGraphFromPayload({
      nodes: [
        { type: 'deployment', id: ROOT_ID, key: `deployment-${ROOT_ID}`, label: 'Cloud WorldView' },
        { type: 'deployment', id: CHILD_ID, key: `deployment-${CHILD_ID}`, label: 'web' },
      ],
      edges: [
        {
          from: { type: 'deployment', id: ROOT_ID },
          to: { type: 'deployment', id: CHILD_ID },
          kind: 'child',
        },
      ],
    });

    expect(graph.type).toBe('directed');
    expect(graph.hasDirectedEdge(`deployment-${ROOT_ID}`, `deployment-${CHILD_ID}`)).toBe(true);
  });

  it('keeps only the selected-node property allow-list', () => {
    const safe = safeWorldViewProperties({
      type: 'deployment',
      id: CHILD_ID,
      properties: {
        kind: 'gcp.run.service',
        target: { provider: 'gcp', scope: 'projects/demo' },
        status: { sync_state: 'current', observed_at: '2026-07-18T00:00:00Z' },
        provider_labels: { environment: 'demo' },
        source_revision: 'abc123',
        artifact_id: ROOT_ID,
        parent_type_id: `deployment-${ROOT_ID}`,
        provider_payload: { secret: 'must-not-render' },
      },
    });

    expect(safe).toEqual({
      kind: 'gcp.run.service',
      target: { provider: 'gcp', scope: 'projects/demo' },
      status: { sync_state: 'current', observed_at: '2026-07-18T00:00:00Z' },
      provider_labels: { environment: 'demo' },
      source_revision: 'abc123',
    });
  });

  it('uses compact canvas labels while preserving the complete source label', () => {
    const fullLabel = `projects/demo/secrets/default_compute_node-${CHILD_ID}/versions/1`;
    const graph = worldViewGraphFromPayload({
      nodes: [{ type: 'deployment', id: CHILD_ID, label: fullLabel }],
      edges: [],
    });
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
