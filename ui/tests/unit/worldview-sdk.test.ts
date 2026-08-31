import {
  ARTIFACT_KINDS,
  Artifact,
  Deployment,
  WorldViewManager,
  WorldViewProjection,
  isValidKind,
  kindAncestors,
  kindMatches,
  normalizeKind,
  normalizeApiPathForBase,
  parseWorldViewGraph,
  type WorldViewGraph,
  type WorldViewHttpClient,
} from '@sdk';
import { describe, expect, it } from 'vitest';

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT_ID = '22222222-2222-5222-8222-222222222222';

function emptyWorldViewGraph(): WorldViewGraph {
  return {
    schema_version: 1,
    projection: WorldViewProjection.DEPLOYMENT,
    root: null,
    nodes: [],
    edges: [],
    counts: { nodes: 0, edges: 0 },
    sync: null,
  };
}

describe('dot-kind ontology', () => {
  it('normalizes, validates, matches descendants, and expands ancestors', () => {
    expect(normalizeKind('  Workload.Service_HTTP.V2 ')).toBe('workload.service_http.v2');
    expect(isValidKind('gcp.run.service')).toBe(true);
    expect(isValidKind('gcp..service')).toBe(false);
    expect(kindMatches('workload.service', 'workload.service.http')).toBe(true);
    expect(kindMatches('workload.service', 'workload.serviceish')).toBe(false);
    expect(kindAncestors('gcp.run.service')).toEqual(['gcp', 'gcp.run']);
    expect(kindAncestors('gcp.run.service', true)).toEqual(['gcp', 'gcp.run', 'gcp.run.service']);
  });
});

describe('Artifact and Deployment SDK models', () => {
  it('adapts a legacy Artifact at read time but writes only the canonical shape', () => {
    const artifact = new Artifact({
      id: ARTIFACT_ID,
      type: 'artifact',
      name: 'Website',
      artifact_type: 'WEBAPP',
      origin: {
        provider: 'github',
        owner: 'flowpad',
        name: 'website',
        branch: 'main',
        rel_path: 'apps/web',
      },
      port: '8080',
      start_cmd: 'npm start',
      metadata: { health: '/healthz' },
    } as never);

    expect(artifact.kind).toBe(ARTIFACT_KINDS.APPLICATION_WEB);
    expect(artifact.origin).toMatchObject({ kind: 'git', owner: 'flowpad', rel_path: 'apps/web' });
    expect(artifact).not.toHaveProperty('artifact_type');
    expect(artifact).not.toHaveProperty('port');
    expect(artifact.toJSON()).toMatchObject({
      type: 'artifact',
      name: 'Website',
      kind: ARTIFACT_KINDS.APPLICATION_WEB,
    });
    expect(artifact.toJSON()).not.toHaveProperty('artifact_type');
    expect(artifact.toJSON()).not.toHaveProperty('metadata');
    expect(artifact.toJSON()).not.toHaveProperty('port');
  });

  it('round-trips the provider-neutral Deployment value objects', () => {
    const deployment = new Deployment({
      id: DEPLOYMENT_ID,
      type: 'deployment',
      name: 'Cloud Run website',
      kind: ' GCP.Run.Service ',
      artifact_id: ARTIFACT_ID,
      artifact_link_source: 'manual',
      target: { provider: 'gcp', scope: 'projects/demo', location: 'us-central1' },
      resource: {
        full_resource_name: '//run.googleapis.com/projects/demo/locations/us-central1/services/web',
        asset_type: 'run.googleapis.com/Service',
      },
      status: { sync_state: 'current', provider_state: 'ACTIVE' },
      labels: ['inventory'],
      provider_labels: { environment: 'demo' },
      observations: {
        cost: {
          metric: 'cost.net',
          coverage: 'available',
          value: 12.5,
          unit: 'USD',
          observed_at: '2026-07-19T00:00:00Z',
          window_start: '2026-06-19T00:00:00Z',
          window_end: '2026-07-19T00:00:00Z',
          source: 'gcp.billing.detailed_export',
        },
        activity: {
          metric: 'activity.requests',
          coverage: 'unavailable',
          observed_at: '2026-07-19T00:00:00Z',
          window_start: '2026-07-18T00:00:00Z',
          window_end: '2026-07-19T00:00:00Z',
          source: 'gcp.monitoring',
        },
      },
      source_revision: 'abc123',
    });

    expect(deployment.kind).toBe('gcp.run.service');
    expect(deployment.toJSON()).toMatchObject({
      type: 'deployment',
      artifact_id: ARTIFACT_ID,
      labels: ['inventory'],
      provider_labels: { environment: 'demo' },
      observations: {
        cost: {
          metric: 'cost.net',
          coverage: 'available',
          value: 12.5,
          unit: 'USD',
        },
        activity: {
          metric: 'activity.requests',
          coverage: 'unavailable',
          value: null,
        },
      },
      target: { provider: 'gcp', scope: 'projects/demo', location: 'us-central1' },
      status: { sync_state: 'current', provider_state: 'ACTIVE' },
    });
  });

  it('does not collapse unavailable observations into a real zero', () => {
    expect(
      () =>
        new Deployment({
          id: '33333333-3333-4333-8333-333333333333',
          type: 'deployment',
          name: 'Invalid observation',
          kind: 'gcp.run.service',
          target: { provider: 'gcp', scope: 'projects/demo' },
          status: { sync_state: 'current' },
          provider_labels: {},
          observations: {
            activity: {
              metric: 'activity.requests',
              coverage: 'unavailable',
              value: 0,
              unit: 'requests',
              observed_at: '2026-07-19T00:00:00Z',
              window_start: '2026-07-18T00:00:00Z',
              window_end: '2026-07-19T00:00:00Z',
              source: 'gcp.monitoring',
            },
          },
        }),
    ).toThrow('must not carry a value');
  });

  it('rejects coercion and incomparable temporal observations', () => {
    const base = {
      id: '44444444-4444-4444-8444-444444444444',
      type: 'deployment',
      name: 'Invalid contract',
      kind: 'gcp.run.service',
      target: { provider: 'gcp', scope: 'projects/demo' },
      status: { sync_state: 'current' as const },
      provider_labels: {},
    };

    expect(
      () =>
        new Deployment({
          ...base,
          id: '55555555-5555-5555-8555-555555555555',
          observations: {
            cost: {
              metric: 'cost.net',
              coverage: 'available',
              value: '12.5',
              unit: 'USD',
              observed_at: '2026-07-19T00:00:00Z',
              window_start: '2026-06-19T00:00:00Z',
              window_end: '2026-07-19T00:00:00Z',
              source: 'gcp.billing.detailed_export',
            },
          },
        } as never),
    ).toThrow('finite value');
    expect(
      () =>
        new Deployment({
          ...base,
          observations: {
            cost: {
              metric: 'cost.net',
              coverage: 'available',
              value: 12.5,
              unit: 'USD',
              observed_at: '2026-07-19T00:00:00Z',
              source: 'gcp.billing.detailed_export',
            },
          },
        }),
    ).toThrow('declared window');
    expect(
      () =>
        new Deployment({
          ...base,
          id: '66666666-6666-4666-8666-666666666666',
          observations: {
            size: {
              metric: 'size.provisioned_bytes',
              coverage: 'available',
              value: 10,
              unit: 'bytes',
              observed_at: '2026-02-30T00:00:00Z',
              source: 'gcp.asset_inventory',
            },
          },
        }),
    ).toThrow('RFC3339');
    expect(
      () =>
        new Deployment({
          ...base,
          id: '77777777-7777-4777-8777-777777777777',
          observations: {
            latency: {
              metric: 'activity.latency',
              coverage: 'available',
              value: 10,
              unit: 'ms',
              observed_at: '2026-07-19T00:00:00Z',
              source: 'gcp.monitoring',
            },
          },
        } as never),
    ).toThrow('invalid observation kind');
  });
});

describe('WorldViewManager', () => {
  it('keeps one API prefix with the configured prefix-bearing apiClient base', () => {
    expect(normalizeApiPathForBase('http://localhost:9008/api/v1', '/api/v1/worldview')).toBe('/worldview');
    expect(normalizeApiPathForBase('http://localhost:9008/api/v1', '/graph/artifact')).toBe('/graph/artifact');
  });

  it('uses canonical API paths and already-unwrapped envelope data', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const graph = emptyWorldViewGraph();
    const client: WorldViewHttpClient = {
      get<T>(path: string): Promise<T> {
        calls.push({ method: 'GET', path });
        return Promise.resolve(graph as T);
      },
      post<T>(path: string, body?: unknown): Promise<T> {
        calls.push({ method: 'POST', path, body });
        if (path.endsWith('/link-artifact')) {
          return Promise.resolve({
            id: DEPLOYMENT_ID,
            type: 'deployment',
            name: 'Cloud Run website',
            kind: 'gcp.run.service',
            artifact_id: ARTIFACT_ID,
            artifact_link_source: 'manual',
            target: { provider: 'gcp', scope: 'projects/demo' },
            resource: null,
            status: { sync_state: 'current' },
            provider_labels: {},
          } as T);
        }
        return Promise.resolve(graph as T);
      },
    };
    const manager = new WorldViewManager(client);

    await expect(manager.load()).resolves.toEqual(graph);
    await expect(manager.refresh(WorldViewProjection.DEPLOYMENT)).resolves.toEqual(graph);
    await expect(manager.sync()).resolves.toEqual(graph);
    await expect(manager.linkArtifact(DEPLOYMENT_ID, ARTIFACT_ID)).resolves.toBeInstanceOf(Deployment);
    expect(calls).toEqual([
      { method: 'GET', path: '/api/v1/worldview/deployment' },
      { method: 'POST', path: '/api/v1/worldview/deployment/refresh', body: {} },
      { method: 'POST', path: '/api/v1/worldview/deployment/refresh', body: {} },
      {
        method: 'POST',
        path: `/api/v1/graph/deployment/${DEPLOYMENT_ID}/link-artifact`,
        body: { artifact_id: ARTIFACT_ID },
      },
    ]);
  });
});

describe('WorldView wire contract', () => {
  it('accepts open node types and distinct typed edges between the same nodes', () => {
    const graph = parseWorldViewGraph({
      schema_version: 1,
      projection: 'organization',
      root: `organization-${ARTIFACT_ID}`,
      nodes: [
        {
          type: 'organization',
          id: ARTIFACT_ID,
          key: `organization-${ARTIFACT_ID}`,
          label: 'Flowpad',
          is_ghost: false,
          properties: {},
        },
        {
          type: 'person',
          id: DEPLOYMENT_ID,
          key: `person-${DEPLOYMENT_ID}`,
          label: 'Ada',
          is_ghost: false,
          properties: {},
        },
      ],
      edges: [
        {
          from: { type: 'organization', id: ARTIFACT_ID },
          to: { type: 'person', id: DEPLOYMENT_ID },
          kind: 'member',
          topology: 'hierarchy',
        },
        {
          from: { type: 'organization', id: ARTIFACT_ID },
          to: { type: 'person', id: DEPLOYMENT_ID },
          kind: 'owner',
          topology: 'association',
        },
      ],
      counts: { nodes: 2, edges: 2 },
      sync: null,
    });

    expect(graph.projection).toBe(WorldViewProjection.ORGANIZATION);
    expect(graph.edges.map((edge) => edge.topology)).toEqual(['hierarchy', 'association']);
  });

  it('rejects extra fields, mismatched counts, and broken graph references', () => {
    expect(() => parseWorldViewGraph({ ...emptyWorldViewGraph(), layout: 'circle' })).toThrow(
      'not part of the WorldView contract',
    );
    expect(() => parseWorldViewGraph({ ...emptyWorldViewGraph(), counts: { nodes: 1, edges: 0 } })).toThrow(
      'counts must match',
    );
    expect(() =>
      parseWorldViewGraph({
        ...emptyWorldViewGraph(),
        root: `deployment-${DEPLOYMENT_ID}`,
      }),
    ).toThrow('root must reference');
    expect(() =>
      parseWorldViewGraph({
        ...emptyWorldViewGraph(),
        nodes: [
          {
            type: 'deployment',
            id: DEPLOYMENT_ID,
            key: `wrong-${DEPLOYMENT_ID}`,
            label: null,
            is_ghost: false,
            properties: {},
          },
        ],
        counts: { nodes: 1, edges: 0 },
      }),
    ).toThrow('key must match');
  });
});
