import { dataManager } from '../APIEntity';
import apiClient from '../client';
import { Deployment } from '../entities/deployment';
import { isValidUUIDv4 } from '../models/TypeId';
import { parseWorldViewGraph, type WorldViewGraph } from './models';
import { WorldViewProjection } from './projection';

/** Minimal injectable client surface; apiClient already unwraps the API envelope. */
export interface WorldViewHttpClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

function graphForProjection(value: unknown, projection: WorldViewProjection): WorldViewGraph {
  const graph = parseWorldViewGraph(value);
  if (graph.projection !== projection) {
    throw new Error(`WorldView response projection ${graph.projection} does not match requested ${projection}`);
  }
  return graph;
}

export class WorldViewManager {
  constructor(private readonly client: WorldViewHttpClient = apiClient as unknown as WorldViewHttpClient) {}

  /** Read the current projection without refreshing its backing data source. */
  async load(projection: WorldViewProjection = WorldViewProjection.DEPLOYMENT): Promise<WorldViewGraph> {
    const graph = await this.client.get<unknown>(`/api/v1/worldview/${encodeURIComponent(projection)}`);
    return graphForProjection(graph, projection);
  }

  /** Explicitly refresh one projection and return its newly validated graph. */
  async refresh(projection: WorldViewProjection): Promise<WorldViewGraph> {
    const graph = await this.client.post<unknown>(`/api/v1/worldview/${encodeURIComponent(projection)}/refresh`, {});
    return graphForProjection(graph, projection);
  }

  /** @deprecated Use refresh(WorldViewProjection.DEPLOYMENT). */
  async sync(): Promise<WorldViewGraph> {
    return this.refresh(WorldViewProjection.DEPLOYMENT);
  }

  /** Explicitly connect one Deployment to one Artifact; no inferred matching. */
  async linkArtifact(deploymentId: string, artifactId: string): Promise<Deployment> {
    if (!isValidUUIDv4(deploymentId)) throw new Error('deploymentId must be a UUID v4 or v5');
    if (!isValidUUIDv4(artifactId)) throw new Error('artifactId must be a UUID v4 or v5');
    const raw = await this.client.post<Record<string, unknown>>(
      `/api/v1/graph/deployment/${encodeURIComponent(deploymentId)}/link-artifact`,
      { artifact_id: artifactId },
    );
    return raw instanceof Deployment ? raw : dataManager.updateEntityFromJson<Deployment>(raw);
  }
}

export const worldViewManager = new WorldViewManager();
