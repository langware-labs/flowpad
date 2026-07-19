import { dataManager } from '../APIEntity';
import apiClient from '../client';
import { Deployment } from '../entities/deployment';
import { isValidUUIDv4 } from '../models/TypeId';
import type { WorldViewGraph } from './models';

/** Minimal injectable client surface; apiClient already unwraps the API envelope. */
export interface WorldViewHttpClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export class WorldViewManager {
  constructor(private readonly client: WorldViewHttpClient = apiClient as unknown as WorldViewHttpClient) {}

  /** Read the current local projection. This never contacts or mutates a cloud provider. */
  async load(): Promise<WorldViewGraph> {
    return this.client.get<WorldViewGraph>('/api/v1/worldview');
  }

  /** Run the explicit read-only provider inventory and return the fresh projection. */
  async sync(): Promise<WorldViewGraph> {
    return this.client.post<WorldViewGraph>('/api/v1/worldview/sync', {});
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
