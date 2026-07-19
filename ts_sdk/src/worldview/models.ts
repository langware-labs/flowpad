import type {
  ArtifactLinkSource,
  DeploymentObservation,
  DeploymentObservationKind,
  DeploymentStatus,
  DeploymentSyncState,
  DeploymentTarget,
  ExternalResourceRef,
} from '../entities/deployment';
import type { FSOriginField } from '../models/FSOrigin';

export type WorldViewEdgeKind = 'child' | 'deployed_as';

export interface WorldViewEndpoint {
  type: string;
  id: string;
}

export interface WorldViewNodeProperties {
  kind: string;
  parent_type_id?: string | null;
  origin?: FSOriginField | null;
  target?: DeploymentTarget | null;
  resource?: ExternalResourceRef | null;
  provider_labels?: Record<string, string>;
  observations?: Partial<Record<DeploymentObservationKind, DeploymentObservation>>;
  status?: DeploymentStatus | null;
  source_revision?: string | null;
  artifact_id?: string | null;
  artifact_link_source?: ArtifactLinkSource | null;
}

export interface WorldViewNode {
  type: 'artifact' | 'deployment';
  id: string;
  key: string;
  label: string | null;
  is_ghost: boolean;
  properties: WorldViewNodeProperties;
}

export interface WorldViewEdge {
  from: WorldViewEndpoint;
  to: WorldViewEndpoint;
  kind: WorldViewEdgeKind;
}

export interface WorldViewCounts {
  nodes: number;
  edges: number;
}

export type WorldViewSyncState = DeploymentSyncState;

export interface WorldViewSyncSummary {
  provider: string;
  state: WorldViewSyncState;
  observed_at: string | null;
  organizations_total: number;
  organizations_succeeded: number;
  organizations_failed: number;
  resources_seen: number;
  created: number;
  updated: number;
  stale: number;
  warnings: string[];
}

/** Fresh main-database projection returned by both load and explicit sync. */
export interface WorldViewGraph {
  /** Null before the first provider sync; sync materializes the deterministic root. */
  root: string | null;
  nodes: WorldViewNode[];
  edges: WorldViewEdge[];
  counts: WorldViewCounts;
  sync: WorldViewSyncSummary | null;
}
